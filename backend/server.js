import 'dotenv/config'
import express from 'express'

const PORT = process.env.PORT || 8787
const ARK_BASE = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
const ARK_KEY = process.env.ARK_API_KEY
const ARK_MODEL = process.env.ARK_MODEL
// 推理模型(如 doubao-seed 系列)设为 "disabled" 可关闭"思考",对话提速;非推理模型留空
const ARK_THINKING = process.env.ARK_THINKING
// Seedream 文生图模型;需在方舟「开通管理」开通对应模型,模型 ID 填这里
const ARK_IMAGE_MODEL = process.env.ARK_IMAGE_MODEL

// 对话式造图的系统提示:多轮聊清画面 → 满意后触发生成。
// 语义画布:模型每轮同时维护并完整返回结构化场景图 scene,前端据此渲染「画面要素板」。
const CHAT_SYSTEM_PROMPT = `你是「语音造图」的 AI 助手。用户只能用语音和你交流;输入来自语音识别,可能有同音错字(如"橙色"被识别成"成色"),按发音与上下文就近纠正理解,不要纠结错字。你们先把"想要的画面"聊清楚并生成,之后还能用语音不断修改这张图,直到满意。

你同时维护一份【场景图 scene】——当前画面的结构化描述,字段全为字符串:
{"style":"风格","usage":"用途","background":"背景","elements":[{"name":"猫","color":"橙色","desc":"坐姿,戴红围巾","pos":"左侧","size":"大"}]}
- 每轮都根据全部对话把 scene 更新到最新并【完整返回】(不是增量);用户每提到一点信息就放进对应字段;未知一律留空字符串。
- elements 最多 8 个;name 是简短名词;desc 放姿态/配饰/神态等细节;pos 只用粗方位(左侧/右侧/上方/下方/中间/背景);color/size 没提就留空。

每轮只输出一个 JSON 对象,四选一(multi 外都必须带 scene):
- 继续聊: {"action":"chat","reply":"…","scene":{…}}
- 生成新图: {"action":"generate","reply":"…","prompt":"…","scene":{…}}
- 修改当前图: {"action":"edit","reply":"…","prompt":"…","scene":{…}}
- 复合指令拆解: {"action":"multi","reply":"…","steps":["回到第2张","把背景换成星空"]}

multi 的使用规则(复杂指令拆解):
- 仅当一句话包含【跨类型的多个动作】才拆,典型:版本/会话操作(回到第N张、撤销、收藏、新对话)与改图/生成混在一句;或明确要求先后出多张图。
- steps 每条是可独立执行的简短中文指令(≤20字),按执行顺序排列,2~4 条;reply 极短地预告(例:"好,分两步~")。
- 【不要拆】同属一次改图的多个改动点:"猫改白色,背景换沙滩"是一次 edit 一并完成——一次重绘更快且画面更一致。

还没有图时:
- 帮用户把画面说清楚,逐步确认四件事:① 画什么(主体/内容)② 风格(写实照片/卡通/油画/水彩/像素/线描…)③ 背景或场景 ④ 用途(头像/海报/壁纸/插画/表情…)。
- 若关键信息缺失(尤其风格、背景、用途),用 chat 友好、口语地一次问清缺的一两项,别一口气问太多。
- 够清楚且用户让你开始("可以了""生成吧""开始画"等)→ 输出 generate。

已经有一张图时(系统会提示"当前已有图"):
- 用户要改它(改颜色/换背景/增减元素/调整大小或位置/换风格等)→ 用 edit,并把 scene 同步改到位。系统会自动把当前图作为参考传给生图模型,你不用管图怎么传。
- edit 的 prompt 要写清"改动后的画面",用"保留X不变,把Y改成Z"或"在…增加…,其余保持不变"这种描述,确保只动该动的、其余维持一致。
- 只有用户明确想要"一张全新、与当前无关的图"时才用 generate。
- 用户只是夸赞/闲聊/问问题(不是要改图)→ 仍用 chat。信息太模糊不足以改 → 先 chat 问清,反问尽量给选项(如"是猫的左边还是画面的左边?")。

prompt 通用要求:依据【更新后的 scene】给出完整中文画面描述,主体+风格+背景+关键细节+色调,尽量具体可成画,不要对话语气词。
reply:会被朗读,要短、自然口语。确认类不超过 14 字(例:"好,这就画~""没问题,猫改橙色~");反问类必须把具体问题问出口、可带选项,不超过 30 字(例:"想要什么风格?卡通还是写实?")。

严格只输出一个 JSON,不要解释、不要 markdown、不要多余文字。`

/** 校验/归一化模型或前端传来的场景图;不合法返回 null。 */
function normalizeScene(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  const str = (v, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const els = Array.isArray(s.elements) ? s.elements : []
  return {
    style: str(s.style),
    usage: str(s.usage),
    background: str(s.background),
    elements: els
      .slice(0, 8)
      .map((e) => ({
        name: str(e?.name, 20),
        color: str(e?.color, 20),
        desc: str(e?.desc),
        pos: str(e?.pos, 20),
        size: str(e?.size, 20),
      }))
      .filter((e) => e.name),
  }
}

/** 对话式造图:把多轮消息发给豆包,强制 JSON 输出 {action, reply, prompt?, scene, steps?}。
 *  hasImage=true 时提示模型"当前已有图",引导它对修改请求用 action="edit";
 *  scene 为前端持有的当前场景图,传给模型作为更新基础;
 *  nosplit=true 表示本条是已拆解出的单步指令,禁止模型再次返回 multi(防递归)。 */
async function callDoubaoChat(messages, hasImage, scene, nosplit) {
  const state = []
  if (hasImage) state.push('画面上已经有一张生成好的图。用户接下来若要修改它,请用 action="edit"(系统会自动把当前图作为参考);只有明确要全新无关的图才用 generate。')
  if (scene) state.push(`当前场景图(请在此基础上更新并完整返回):${JSON.stringify(scene)}`)
  if (nosplit) state.push('本条是复合指令拆解后的单步,必须直接执行(chat/generate/edit 三选一),禁止返回 multi。')
  const system = state.length ? `${CHAT_SYSTEM_PROMPT}\n\n【当前状态】\n${state.join('\n')}` : CHAT_SYSTEM_PROMPT
  const resp = await fetch(`${ARK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ARK_KEY}`,
    },
    body: JSON.stringify({
      model: ARK_MODEL,
      messages: [{ role: 'system', content: system }, ...messages],
      response_format: { type: 'json_object' },
      temperature: 0.6, // 对话比解析更需要自然,略升温
      max_tokens: 1600, // scene 随每轮完整返回,额度比纯对话略放宽
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

/**
 * 调用火山方舟 Seedream 文生图,返回图片 URL。
 * 传 image(当前图 URL)即进入「编辑模式」:以该图为参考,只改 prompt 所述、保留其余
 * ——Seedream 生成/编辑同一接口,差别只在多一个 image 参数。
 */
async function callSeedream(prompt, image) {
  const body = {
    model: ARK_IMAGE_MODEL,
    prompt,
    size: '2048x2048', // 需 ≥ 3,686,400 像素
    response_format: 'url',
    watermark: false,
  }
  if (image) body.image = image
  const resp = await fetch(`${ARK_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ARK_KEY}`,
    },
    body: JSON.stringify(body),
  })
  const data = await resp.json()
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Ark ${resp.status}`)
  }
  const url = data?.data?.[0]?.url
  if (!url) throw new Error('生图返回为空')
  return url
}

const app = express()
app.use(express.json())

// 健康检查
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// 多轮对话造图:语音文本会话 → 豆包(继续聊 or 触发生成)
app.post('/api/chat', async (req, res) => {
  const raw = Array.isArray(req.body?.messages) ? req.body.messages : []
  const messages = raw
    .filter(
      (m) =>
        (m?.role === 'user' || m?.role === 'assistant') &&
        typeof m?.content === 'string' &&
        m.content.trim(),
    )
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .slice(-20) // 只带最近若干轮,控制延迟与成本
  if (messages.length === 0) {
    return res.status(400).json({ ok: false, reason: '缺少对话内容' })
  }
  if (!ARK_KEY || !ARK_MODEL) {
    return res.status(500).json({ ok: false, reason: '后端未配置 ARK_API_KEY / ARK_MODEL(见 backend/.env.example)' })
  }
  const hasImage = req.body?.hasImage === true
  const clientScene = normalizeScene(req.body?.scene)
  const nosplit = req.body?.nosplit === true
  try {
    const out = await callDoubaoChat(messages, hasImage, clientScene, nosplit)
    const reply = typeof out?.reply === 'string' && out.reply.trim() ? out.reply.trim() : '嗯,你再多说说想要的画面?'
    // 复合指令拆解:校验 steps;nosplit 时即使模型仍返回 multi 也不下发(防递归),退化为 chat
    if (out?.action === 'multi' && !nosplit) {
      const steps = (Array.isArray(out?.steps) ? out.steps : [])
        .map((s) => (typeof s === 'string' ? s.trim().slice(0, 40) : ''))
        .filter(Boolean)
        .slice(0, 4)
      if (steps.length >= 2) return res.json({ ok: true, action: 'multi', reply, steps })
    }
    // 模型返回的场景图;不合法时回退为请求里的旧场景,保证前端要素板不闪没
    const scene = normalizeScene(out?.scene) || clientScene
    if (out?.action === 'generate' || out?.action === 'edit') {
      const prompt = typeof out?.prompt === 'string' ? out.prompt.trim() : ''
      if (prompt) return res.json({ ok: true, action: out.action, reply, prompt, ...(scene ? { scene } : {}) })
    }
    res.json({ ok: true, action: 'chat', reply, ...(scene ? { scene } : {}) })
  } catch (e) {
    console.error('[chat] 豆包调用失败:', e?.message || e)
    res.status(502).json({ ok: false, reason: '对话失败,请重试' })
  }
})

// 画面描述 → 图片(Seedream);prompt 由对话产出。带 image 则为「编辑当前图」,否则全新生成
app.post('/api/generate', async (req, res) => {
  const prompt = (req.body?.prompt ?? '').toString().trim()
  const image = typeof req.body?.image === 'string' && req.body.image.trim() ? req.body.image.trim() : null
  if (!prompt) {
    return res.status(400).json({ ok: false, reason: '缺少 prompt' })
  }
  if (!ARK_KEY || !ARK_IMAGE_MODEL) {
    return res.status(500).json({ ok: false, reason: '后端未配置 ARK_API_KEY / ARK_IMAGE_MODEL(见 backend/.env.example)' })
  }
  try {
    const url = await callSeedream(prompt, image)
    res.json({ ok: true, url })
  } catch (e) {
    console.error('[generate] Seedream 调用失败:', e?.message || e)
    res.status(502).json({ ok: false, reason: `生图失败:${e?.message || '请重试'}` })
  }
})

app.listen(PORT, () => {
  console.log(`语音造图后端已启动:http://localhost:${PORT}`)
  if (!ARK_KEY || !ARK_MODEL) {
    console.warn('⚠️  未检测到 ARK_API_KEY / ARK_MODEL,/api/chat 将返回配置错误。请复制 .env.example 为 .env 并填写。')
  }
})
