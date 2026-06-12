import 'dotenv/config'
import express from 'express'

const PORT = process.env.PORT || 8787
const ARK_BASE = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
const ARK_KEY = process.env.ARK_API_KEY
const ARK_MODEL = process.env.ARK_MODEL
// 推理模型(如 doubao-seed 系列)设为 "disabled" 可关闭"思考",解析提速 2~3 倍;非推理模型留空
const ARK_THINKING = process.env.ARK_THINKING
// Seedream 文生图模型(生成式收尾用);需在方舟「开通管理」开通对应模型,模型 ID 填这里
const ARK_IMAGE_MODEL = process.env.ARK_IMAGE_MODEL

// 与前端 commands.ts 对齐的取值域(后端做最终校验,不信任模型输出)
const SHAPES = ['circle', 'rect', 'triangle', 'line']
const SIZES = ['small', 'medium', 'large']
const POSITIONS = [
  'top-left', 'top', 'top-right',
  'left', 'center', 'right',
  'bottom-left', 'bottom', 'bottom-right',
]
const DEFAULT_COLOR = '#3498db'

const SYSTEM_PROMPT = `你是语音绘图工具的指令解析器。把用户的一句中文语音指令解析成一个 JSON 对象,只输出 JSON,不要解释、不要 markdown 代码块。

可用动作 action:
- "draw":画一个新图形。附加 shape / color / size / position。
- "clear":清空画布。
- "undo":撤销上一步;"redo":重做。
- "delete":删除一个已有图形。附加 target。
- "edit":修改一个已有图形。附加 target 和 patch。
- "generate":把场景渲染成写实大图(用户说"渲染成…""生成一张…""画一张…的照片"等)。附加 prompt。
- "unknown":无法理解或不支持。附加 reason。

字段取值:
- shape: "circle"(圆) | "rect"(方块/矩形/正方形) | "triangle"(三角) | "line"(线)。只支持这四种,其他形状(房子/猫…)用 unknown。
- color: CSS 颜色,十六进制如 "#87CEEB" 或英文名如 "red";判断不了填 ""。("天蓝"→"#87CEEB")
- size: "small"(小/迷你) | "medium"(中/默认) | "large"(大/巨大)。
- position: "top-left" "top" "top-right" "left" "center" "right" "bottom-left" "bottom" "bottom-right"(九宫格,判断不了填 "center")。
- target(delete/edit 用,指明操作哪个图形):
  - 按编号: {"by":"number","n":2}(用户说"2号""第二个")
  - 指代最近操作的: {"by":"focus"}(用户说"它""这个""刚才那个""上一个")
- patch(edit 用,只填用户提到的项):
  - "color": CSS 颜色(改颜色)
  - "sizeStep": 1(变大/放大)或 -1(变小/缩小)
  - "position": 九宫格之一(移动到某处)
- prompt(generate 用): 用户想要的画面描述文字,尽量保留原话场景描述。

判断要点:
- 想"画/添加"新图形 → draw;想改已有图形的颜色/大小/位置 → edit;想删 → delete。
- "把它/这个/刚才那个/上一个…" → target.by="focus";"N号/第N个" → target.by="number"。
- 只输出一个 JSON 对象。

示例:
"画一个红色的大圆" → {"action":"draw","shape":"circle","color":"#e74c3c","size":"large","position":"center"}
"在左上角画个蓝方块" → {"action":"draw","shape":"rect","color":"#3498db","size":"medium","position":"top-left"}
"把2号变红" → {"action":"edit","target":{"by":"number","n":2},"patch":{"color":"#e74c3c"}}
"把它放大" → {"action":"edit","target":{"by":"focus"},"patch":{"sizeStep":1}}
"第三个挪到右下角" → {"action":"edit","target":{"by":"number","n":3},"patch":{"position":"bottom-right"}}
"删掉第二个" → {"action":"delete","target":{"by":"number","n":2}}
"把刚才那个删了" → {"action":"delete","target":{"by":"focus"}}
"撤销" → {"action":"undo"}
"清空" → {"action":"clear"}
"渲染成夕阳下的湖边小屋" → {"action":"generate","prompt":"夕阳下的湖边小屋"}
"画一只猫" → {"action":"unknown","reason":"暂只支持圆/方块/三角/线四种基础图形"}`

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

/** 调用火山方舟 Seedream 文生图,返回图片 URL。 */
async function callSeedream(prompt) {
  const resp = await fetch(`${ARK_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ARK_KEY}`,
    },
    body: JSON.stringify({
      model: ARK_IMAGE_MODEL,
      prompt,
      size: '2048x2048', // 需 ≥ 3,686,400 像素
      response_format: 'url',
      watermark: false,
    }),
  })
  const data = await resp.json()
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Ark ${resp.status}`)
  }
  const url = data?.data?.[0]?.url
  if (!url) throw new Error('生图返回为空')
  return url
}

/** 校验颜色:非空字符串原样用(Konva 接受 CSS 名与十六进制),否则给默认色。 */
function normColor(c) {
  return typeof c === 'string' && c.trim() ? c.trim() : DEFAULT_COLOR
}

/** 校验操作目标:{by:'number',n} 或 {by:'focus'};非法返回 null。 */
function normTarget(t) {
  if (t?.by === 'focus') return { by: 'focus' }
  if (t?.by === 'number' && Number.isInteger(t.n) && t.n >= 1) return { by: 'number', n: t.n }
  return null
}

/** 校验编辑 patch:只保留 color / sizeStep(±1) / position;全空返回 null。 */
function normPatch(p) {
  if (!p || typeof p !== 'object') return null
  const out = {}
  if (typeof p.color === 'string' && p.color.trim()) out.color = p.color.trim()
  if (p.sizeStep === 1 || p.sizeStep === -1) out.sizeStep = p.sizeStep
  if (POSITIONS.includes(p.position)) out.position = p.position
  return Object.keys(out).length > 0 ? out : null
}

/** 把模型输出归一化为前端可执行的指令(防御式校验,与前端 commands.ts 对齐)。 */
function normalize(raw) {
  switch (raw?.action) {
    case 'clear':
      return { ok: true, command: { action: 'clear' } }
    case 'undo':
      return { ok: true, command: { action: 'undo' } }
    case 'redo':
      return { ok: true, command: { action: 'redo' } }
    case 'draw':
      if (!SHAPES.includes(raw.shape)) {
        return { ok: false, reason: '暂不支持这种图形(仅圆 / 方块 / 三角 / 线)' }
      }
      return {
        ok: true,
        command: {
          action: 'draw',
          shape: raw.shape,
          color: normColor(raw.color),
          size: SIZES.includes(raw.size) ? raw.size : 'medium',
          position: POSITIONS.includes(raw.position) ? raw.position : 'center',
        },
      }
    case 'delete': {
      const target = normTarget(raw.target)
      if (!target) return { ok: false, reason: '没说清删哪个图形' }
      return { ok: true, command: { action: 'delete', target } }
    }
    case 'edit': {
      const target = normTarget(raw.target)
      if (!target) return { ok: false, reason: '没说清改哪个图形' }
      const patch = normPatch(raw.patch)
      if (!patch) return { ok: false, reason: '没说清怎么改' }
      return { ok: true, command: { action: 'edit', target, patch } }
    }
    case 'generate': {
      const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
      if (!prompt) return { ok: false, reason: '想渲染成什么?请说「渲染成」加画面描述' }
      return { ok: true, command: { action: 'generate', prompt } }
    }
    default: {
      const reason = typeof raw?.reason === 'string' && raw.reason ? raw.reason : '没理解这条指令'
      return { ok: false, reason }
    }
  }
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

// 场景描述 → 写实大图(Seedream 文生图,生成式收尾)
app.post('/api/generate', async (req, res) => {
  const prompt = (req.body?.prompt ?? '').toString().trim()
  if (!prompt) {
    return res.status(400).json({ ok: false, reason: '缺少 prompt' })
  }
  if (!ARK_KEY || !ARK_IMAGE_MODEL) {
    return res.status(500).json({ ok: false, reason: '后端未配置 ARK_API_KEY / ARK_IMAGE_MODEL(见 backend/.env.example)' })
  }
  try {
    // 追加写实风格提示,把"语音搭的场景"推向照片级真实
    const styled = `${prompt}。写实摄影风格,真实自然光照,丰富细节,高清,色彩自然`
    const url = await callSeedream(styled)
    res.json({ ok: true, url })
  } catch (e) {
    console.error('[generate] Seedream 调用失败:', e?.message || e)
    res.status(502).json({ ok: false, reason: `生图失败:${e?.message || '请重试'}` })
  }
})

app.listen(PORT, () => {
  console.log(`say-draw 后端已启动:http://localhost:${PORT}`)
  if (!ARK_KEY || !ARK_MODEL) {
    console.warn('⚠️  未检测到 ARK_API_KEY / ARK_MODEL,/api/parse 将返回配置错误。请复制 .env.example 为 .env 并填写。')
  }
})
