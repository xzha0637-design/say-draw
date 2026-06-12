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

const SYSTEM_PROMPT = `你是语音绘图工具的指令解析器。把用户的一句中文语音指令解析成一个 JSON 对象 {"ops":[...]},ops 是按顺序执行的操作数组(一句话可能含多个操作)。只输出 JSON,不要解释、不要 markdown。

每个 op 的 action:
- "draw":画一个东西。基础几何用 shape;其它任何物体(房子/猫/树/星星/汽车/爱心…)用 shape="icon" 并给 emoji 和 label。
- "clear":清空;"undo":撤销;"redo":重做。
- "delete":删除一个已有图形,带 target。
- "edit":修改一个已有图形,带 target 和 patch。
- "generate":渲染成写实大图(用户说"渲染成…""生成一张…"),带 prompt。
- "unknown":无法理解,带 reason。

字段:
- shape: "circle"(圆) "rect"(方/矩形) "triangle"(三角) "line"(线) —— 仅这四种基础几何;其它物体一律用 "icon"。
- emoji: shape="icon" 时必填,选最贴切的一个 emoji(房子→🏠 猫→🐱 树→🌳 太阳→☀️ 星星→⭐ 汽车→🚗 花→🌸 月亮→🌙 房车人山水…都给对应 emoji)。
- label: 物体中文名(房子/猫…),draw 尽量都填。
- color: CSS 颜色十六进制或英文名,判断不了填 "";size: small|medium|large;position: top-left|top|top-right|left|center|right|bottom-left|bottom|bottom-right(判断不了填 center)。
- target: {"by":"number","n":2}("2号""第二个") 或 {"by":"focus"}("它""这个""刚才那个""上一个")。
- patch(edit,只填提到的): color / sizeStep(1变大 -1变小) / position。
- prompt(generate): 画面描述文字。

要点:
- 想"画/添加"新东西 → draw;基础几何用对应 shape,其它物体一律 icon+emoji(几乎不用 unknown)。
- 一句话多个动作 → ops 放多个,按说话顺序。
- 严格只输出 {"ops":[...]} 一个 JSON。

示例:
"画一个红色的大圆" → {"ops":[{"action":"draw","shape":"circle","color":"#e74c3c","size":"large","position":"center","label":"圆"}]}
"画一个房子" → {"ops":[{"action":"draw","shape":"icon","emoji":"🏠","label":"房子","size":"medium","position":"center"}]}
"左边画棵树右边画个太阳" → {"ops":[{"action":"draw","shape":"icon","emoji":"🌳","label":"树","size":"medium","position":"left"},{"action":"draw","shape":"icon","emoji":"☀️","label":"太阳","size":"medium","position":"top-right"}]}
"画个圆再把它变红" → {"ops":[{"action":"draw","shape":"circle","size":"medium","position":"center","label":"圆"},{"action":"edit","target":{"by":"focus"},"patch":{"color":"#e74c3c"}}]}
"把2号变红,3号删掉" → {"ops":[{"action":"edit","target":{"by":"number","n":2},"patch":{"color":"#e74c3c"}},{"action":"delete","target":{"by":"number","n":3}}]}
"撤销" → {"ops":[{"action":"undo"}]}
"清空" → {"ops":[{"action":"clear"}]}
"渲染成夕阳下的湖边小屋" → {"ops":[{"action":"generate","prompt":"夕阳下的湖边小屋"}]}`

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

/** 校验并归一化单个操作 → 前端 Command;非法返回 null。 */
function normalizeOne(raw) {
  const label = typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined
  switch (raw?.action) {
    case 'clear':
      return { action: 'clear' }
    case 'undo':
      return { action: 'undo' }
    case 'redo':
      return { action: 'redo' }
    case 'draw': {
      const base = {
        action: 'draw',
        color: normColor(raw.color),
        size: SIZES.includes(raw.size) ? raw.size : 'medium',
        position: POSITIONS.includes(raw.position) ? raw.position : 'center',
        label,
      }
      if (raw.shape === 'icon') {
        const emoji = typeof raw.emoji === 'string' && raw.emoji.trim() ? raw.emoji.trim() : null
        return emoji ? { ...base, shape: 'icon', emoji } : null
      }
      return SHAPES.includes(raw.shape) ? { ...base, shape: raw.shape } : null
    }
    case 'delete': {
      const target = normTarget(raw.target)
      return target ? { action: 'delete', target } : null
    }
    case 'edit': {
      const target = normTarget(raw.target)
      const patch = normPatch(raw.patch)
      return target && patch ? { action: 'edit', target, patch } : null
    }
    case 'generate': {
      const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
      return prompt ? { action: 'generate', prompt } : null
    }
    default:
      return null
  }
}

/** 把模型输出 {ops:[...]} 归一化为前端可执行的指令数组(一句话可含多个操作)。 */
function normalizeOps(raw) {
  const ops = Array.isArray(raw?.ops) ? raw.ops : []
  const commands = []
  let reason = '没理解这条指令'
  for (const op of ops) {
    if (op?.action === 'unknown' && typeof op.reason === 'string' && op.reason) reason = op.reason
    const c = normalizeOne(op)
    if (c) commands.push(c)
  }
  if (commands.length === 0) return { ok: false, reason }
  return { ok: true, commands }
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
    res.json(normalizeOps(await callDoubao(text)))
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
