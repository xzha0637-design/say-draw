import 'dotenv/config'
import express from 'express'

const PORT = process.env.PORT || 8787
const ARK_BASE = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
const ARK_KEY = process.env.ARK_API_KEY
const ARK_MODEL = process.env.ARK_MODEL
// 推理模型(如 doubao-seed 系列)设为 "disabled" 可关闭"思考",解析提速 2~3 倍;非推理模型留空
const ARK_THINKING = process.env.ARK_THINKING

// 与前端 commands.ts 对齐的取值域(后端做最终校验,不信任模型输出)
const SHAPES = ['circle', 'rect', 'triangle', 'line']
const SIZES = ['small', 'medium', 'large']
const POSITIONS = [
  'top-left', 'top', 'top-right',
  'left', 'center', 'right',
  'bottom-left', 'bottom', 'bottom-right',
]
const DEFAULT_COLOR = '#3498db'

const SYSTEM_PROMPT = `你是语音绘图工具的指令解析器。把用户的中文绘图指令解析成一个 JSON 对象,只输出 JSON,不要解释。

字段与取值:
- action: "draw"(绘制) | "clear"(清空画布) | "unknown"(无法理解或不支持)
- 当 action="draw" 时还需:
  - shape: "circle"(圆) | "rect"(方块/矩形/正方形) | "triangle"(三角形) | "line"(线)
  - color: CSS 颜色字符串(十六进制如 "#87CEEB",或英文名如 "skyblue");无法判断填 ""
  - size: "small"(小/迷你) | "medium"(中/默认) | "large"(大/巨大)
  - position: "top-left" "top" "top-right" "left" "center" "right" "bottom-left" "bottom" "bottom-right"(九宫格;无法判断填 "center")
- 当 action="unknown" 时:加 "reason" 字段简短说明(如 "不支持的图形:五角星")。

规则:
- 形状只能是上述四种;用户要的形状不在其中时,用 action="unknown" 并说明。
- 颜色尽量给准确的十六进制或英文名(如 "天蓝色"→"#87CEEB","土黄色"→"#cca300")。
- 模糊量词("大一点""小小的""特别大")映射到 small/medium/large。
- 严格只输出一个 JSON 对象,不要 markdown 代码块。`

/** 调用火山方舟(OpenAI 兼容)聊天补全,强制 JSON 输出。 */
async function callDoubao(text) {
  const resp = await fetch(`${ARK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ARK_KEY}`,
    },
    body: JSON.stringify({
      model: ARK_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      ...(ARK_THINKING ? { thinking: { type: ARK_THINKING } } : {}),
    }),
  })
  if (!resp.ok) {
    throw new Error(`Ark ${resp.status}: ${await resp.text()}`)
  }
  const data = await resp.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('模型返回空内容')
  return JSON.parse(content)
}

/** 把模型输出归一化为前端可执行的指令(防御式校验,带默认值)。 */
function normalize(raw) {
  if (raw?.action === 'clear') {
    return { ok: true, command: { action: 'clear' } }
  }
  if (raw?.action === 'draw') {
    if (!SHAPES.includes(raw.shape)) {
      return { ok: false, reason: '暂不支持这种图形(仅圆 / 方块 / 三角 / 线)' }
    }
    return {
      ok: true,
      command: {
        action: 'draw',
        shape: raw.shape,
        color: typeof raw.color === 'string' && raw.color.trim() ? raw.color.trim() : DEFAULT_COLOR,
        size: SIZES.includes(raw.size) ? raw.size : 'medium',
        position: POSITIONS.includes(raw.position) ? raw.position : 'center',
      },
    }
  }
  const reason = typeof raw?.reason === 'string' && raw.reason ? raw.reason : '没理解这条指令'
  return { ok: false, reason }
}

const app = express()
app.use(express.json())

// 健康检查
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// 语音指令 → 结构化绘图指令(豆包慢路)
app.post('/api/parse', async (req, res) => {
  const text = (req.body?.text ?? '').toString().trim()
  if (!text) {
    return res.status(400).json({ ok: false, reason: '缺少 text' })
  }
  if (!ARK_KEY || !ARK_MODEL) {
    return res.status(500).json({ ok: false, reason: '后端未配置 ARK_API_KEY / ARK_MODEL(见 backend/.env.example)' })
  }
  try {
    res.json(normalize(await callDoubao(text)))
  } catch (e) {
    console.error('[parse] 豆包调用失败:', e?.message || e)
    res.status(502).json({ ok: false, reason: '豆包解析失败,请重试' })
  }
})

app.listen(PORT, () => {
  console.log(`say-draw 后端已启动:http://localhost:${PORT}`)
  if (!ARK_KEY || !ARK_MODEL) {
    console.warn('⚠️  未检测到 ARK_API_KEY / ARK_MODEL,/api/parse 将返回配置错误。请复制 .env.example 为 .env 并填写。')
  }
})
