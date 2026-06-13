import 'dotenv/config'
import express from 'express'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import * as store from './store.js'

const PORT = process.env.PORT || 8787
const ARK_BASE = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
const ARK_KEY = process.env.ARK_API_KEY
const ARK_MODEL = process.env.ARK_MODEL
// 推理模型(如 doubao-seed 系列)设为 "disabled" 可关闭"思考",对话提速;非推理模型留空
const ARK_THINKING = process.env.ARK_THINKING
// Seedream 文生图模型;需在方舟「开通管理」开通对应模型,模型 ID 填这里
const ARK_IMAGE_MODEL = process.env.ARK_IMAGE_MODEL

// 七牛云流式语音识别(WebSocket;OpenAI 兼容平台,Bearer 鉴权)。
// 配置 QINIU_AI_KEY 后前端走云端识别(跨浏览器、内地可用);未配置则回退浏览器 Web Speech,保主分支可运行。
const QINIU_AI_KEY = process.env.QINIU_AI_KEY
const QINIU_ASR_WS = process.env.QINIU_ASR_WS || 'wss://api.qnaigc.com/v1/voice/asr'
const QINIU_ASR_MODEL = process.env.QINIU_ASR_MODEL || 'asr'

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
- ⚠️【避免无谓重绘 —— 最重要的判断】每次 edit/generate 都要花约 20 秒并产生费用,所以【只有】用户给出明确、具体、可执行的画面改动时才用 edit。凡是语气词、口头确认(嗯/好/可以/行/不错/就这样)、夸奖、笑声、与画面无关的闲聊或提问、没听清、意图不明确的话——【一律用 chat,绝不重绘】,用一句很短的话回应或反问即可。宁可不画,也不要凭空重画一张几乎一样的图。
- 用户要改它(改颜色/换背景/增减元素/调整大小或位置/换风格等)→ 用 edit,并把 scene 同步改到位。系统会自动把当前图作为参考传给生图模型,你不用管图怎么传。
- edit 的 prompt 要写清"改动后的画面",用"保留X不变,把Y改成Z"或"在…增加…,其余保持不变"这种描述,确保只动该动的、其余维持一致。
- 只有用户明确想要"一张全新、与当前无关的图"时才用 generate。
- 信息太模糊不足以改 → 先 chat 问清,反问尽量给选项(如"是猫的左边还是画面的左边?")。

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

// ───────── 七牛云流式 ASR:二进制帧协议(版本1 / JSON 序列化 / gzip;消息类型 1=配置 2=音频)─────────
// 协议见 https://developer.qiniu.com/aitokenapi/12981/asr-tts-ocr-api 的 Node/Python 示例。
// 帧格式:[4 字节头][4 字节序列号][4 字节 payload 长度][gzip(payload)]。
function asrHeader(messageType) {
  const h = Buffer.alloc(4)
  h[0] = (1 << 4) | 1 // 协议版本 1 | header size 1(=4 字节)
  h[1] = (messageType << 4) | 1 // 消息类型 | flags=1(带序列号)
  h[2] = (1 << 4) | 1 // 序列化=1(JSON) | 压缩=1(gzip)
  h[3] = 0
  return h
}
function asrFrame(messageType, seq, payload) {
  const gz = zlib.gzipSync(payload)
  const seqBuf = Buffer.alloc(4)
  seqBuf.writeInt32BE(seq)
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeInt32BE(gz.length)
  return Buffer.concat([asrHeader(messageType), seqBuf, lenBuf, gz])
}
/** 解析服务端返回帧,取累计识别文本(失败返回 '')。 */
function parseAsrText(data) {
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const headerSize = buf[0] & 0x0f
    const messageType = buf[1] >> 4
    const flags = buf[1] & 0x0f
    const serialization = buf[2] >> 4
    const compression = buf[2] & 0x0f
    let payload = buf.slice(headerSize * 4)
    if (flags & 0x01) payload = payload.slice(4) // 跳过序列号
    if (messageType === 0b1001 && payload.length >= 4) {
      const size = payload.readInt32BE(0) // 完整服务端响应:前 4 字节是长度
      payload = payload.slice(4, 4 + size)
    }
    if (compression === 0b0001) payload = zlib.gunzipSync(payload)
    const obj = serialization === 0b0001 ? JSON.parse(payload.toString('utf8')) : payload.toString('utf8')
    return obj?.result?.text || obj?.payload_msg?.result?.text || ''
  } catch {
    return ''
  }
}

/**
 * WebSocket 代理:浏览器 PCM 帧 → 七牛云流式 ASR → 累计文本回浏览器。
 * 代理而非浏览器直连的原因:把 API Key 与二进制协议都留在服务端,浏览器只推裸 PCM、收 {text}。
 */
function attachAsrProxy(server) {
  const wss = new WebSocketServer({ server, path: '/api/asr/stream' })
  wss.on('connection', (client) => {
    if (!QINIU_AI_KEY) {
      client.close(1011, 'ASR 未配置')
      return
    }
    let seq = 1
    let ready = false
    const queue = [] // 上游就绪前缓存浏览器音频帧
    const upstream = new WebSocket(QINIU_ASR_WS, { headers: { Authorization: `Bearer ${QINIU_AI_KEY}` } })

    upstream.on('open', () => {
      const config = {
        user: { uid: randomUUID() },
        audio: { format: 'pcm', sample_rate: 16000, bits: 16, channel: 1, codec: 'raw' },
        request: { model_name: QINIU_ASR_MODEL, enable_punc: true },
      }
      upstream.send(asrFrame(1, seq, Buffer.from(JSON.stringify(config), 'utf8')))
      ready = true
      for (const chunk of queue) upstream.send(asrFrame(2, ++seq, chunk))
      queue.length = 0
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ reset: true }))
    })
    upstream.on('message', (data) => {
      const text = parseAsrText(data)
      if (text && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ text }))
    })
    upstream.on('error', (e) => {
      console.error('[asr] 上游错误:', e?.message || e)
      if (client.readyState === WebSocket.OPEN) client.close(1011, '上游识别错误')
    })
    upstream.on('close', () => {
      if (client.readyState === WebSocket.OPEN) client.close()
    })

    client.on('message', (data, isBinary) => {
      if (!isBinary) return // 只处理二进制 PCM 帧
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!ready) {
        queue.push(chunk)
        return
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(asrFrame(2, ++seq, chunk))
    })
    const closeUpstream = () => {
      try {
        upstream.close()
      } catch {
        /* noop */
      }
    }
    client.on('close', closeUpstream)
    client.on('error', closeUpstream)
  })
}

const app = express()
app.use(express.json({ limit: '512kb' })) // 会话快照含多版本场景图,放宽默认 100kb

// 健康检查
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// 云端 ASR 是否可用:前端据此决定走云端流式识别还是回退浏览器 Web Speech
app.get('/api/asr/status', (_req, res) => res.json({ enabled: !!QINIU_AI_KEY }))
// 流式识别本体走 WebSocket /api/asr/stream(见文件末尾 attachAsrProxy)

// ───────────────── 登录与会话隔离(user_id × session_id) ─────────────────

// 注册 / 登录:成功都返回 { token, userId, username },前端持 token 调会话接口
app.post('/api/auth/register', (req, res) => {
  const username = (req.body?.username ?? '').toString().trim()
  const password = (req.body?.password ?? '').toString()
  if (!/^[\w一-龥]{2,20}$/.test(username)) {
    return res.status(400).json({ ok: false, reason: '用户名需 2~20 位(中英文/数字/下划线)' })
  }
  if (password.length < 4) {
    return res.status(400).json({ ok: false, reason: '密码至少 4 位' })
  }
  const r = store.register(username, password)
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

app.post('/api/auth/login', (req, res) => {
  const username = (req.body?.username ?? '').toString().trim()
  const password = (req.body?.password ?? '').toString()
  const r = store.login(username, password)
  if (!r.ok) return res.status(401).json(r)
  res.json(r)
})

// 鉴权中间件:Bearer token → req.userId;之后的数据读写天然按用户隔离
function requireAuth(req, res, next) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '')
  const t = m && store.auth(m[1])
  if (!t) return res.status(401).json({ ok: false, reason: '未登录或登录已失效' })
  req.userId = t.userId
  next()
}

// 软鉴权:有有效令牌则置 req.userId,否则放行(req.userId 为空)。
// 给 /api/generate 用——登录用户的图入库归档,匿名访客退化为旧版纯代理,保证主分支始终可运行。
function optionalAuth(req, _res, next) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '')
  const t = m && store.auth(m[1])
  if (t) req.userId = t.userId
  next()
}

/** 会话快照入库前的归一化:形状校验 + 数量/长度上限,坏数据不落盘。 */
function normalizeSnapshot(body) {
  const history = (Array.isArray(body?.history) ? body.history : [])
    .filter(
      (m) =>
        (m?.role === 'user' || m?.role === 'assistant') &&
        typeof m?.content === 'string' &&
        m.content.trim(),
    )
    .slice(-200)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
  const versions = (Array.isArray(body?.versions) ? body.versions : [])
    .slice(0, 50)
    .map((v) => ({
      url: typeof v?.url === 'string' ? v.url.slice(0, 2048) : '',
      downloadUrl: typeof v?.downloadUrl === 'string' ? v.downloadUrl.slice(0, 2048) : '',
      imageId: typeof v?.imageId === 'string' ? v.imageId.slice(0, 64) : '',
      starred: v?.starred === true,
      scene: normalizeScene(v?.scene),
    }))
    .filter((v) => v.url)
  const idx = Number.isInteger(body?.currentIndex) ? body.currentIndex : -1
  return {
    history,
    scene: normalizeScene(body?.scene),
    versions,
    currentIndex: idx >= -1 && idx < versions.length ? idx : versions.length - 1,
  }
}

// 会话 CRUD:列表 / 新建 / 读取 / 保存(前端每轮自动保存)
app.get('/api/conversations', requireAuth, (req, res) => {
  res.json({ ok: true, conversations: store.listConversations(req.userId) })
})

app.post('/api/conversations', requireAuth, (req, res) => {
  res.json({ ok: true, conversation: store.createConversation(req.userId) })
})

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = store.getConversation(req.userId, req.params.id)
  if (!conv) return res.status(404).json({ ok: false, reason: '会话不存在' })
  res.json({ ok: true, conversation: conv })
})

app.put('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = store.saveConversation(req.userId, req.params.id, normalizeSnapshot(req.body))
  if (!conv) return res.status(404).json({ ok: false, reason: '会话不存在' })
  res.json({ ok: true, updatedAt: conv.updatedAt, title: conv.title })
})

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  if (!store.deleteConversation(req.userId, req.params.id)) {
    return res.status(404).json({ ok: false, reason: '会话不存在' })
  }
  res.json({ ok: true })
})

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

/** 下载 Seedream 外链字节,用于入库归档。失败返回 null(降级:仍可用外链显示)。 */
async function fetchImageBytes(url) {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const mime = r.headers.get('content-type') || 'image/jpeg'
    return { buf, mime: mime.split(';')[0].trim() }
  } catch {
    return null
  }
}

// 画面描述 → 图片(Seedream)。登录用户:出图字节入库,返回持久「能力 URL」+ 下载链接;
// 匿名访客:退化为直接返回 Seedream 外链(旧行为,保证主分支随时可运行)。
// 改图:登录态用 imageId 取回原始外链作参考图;匿名态用 image(外链)作参考。
app.post('/api/generate', optionalAuth, async (req, res) => {
  const prompt = (req.body?.prompt ?? '').toString().trim()
  const legacyRef = typeof req.body?.image === 'string' && req.body.image.trim() ? req.body.image.trim() : null
  const refImageId = typeof req.body?.imageId === 'string' ? req.body.imageId.trim() : ''
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : null
  if (!prompt) {
    return res.status(400).json({ ok: false, reason: '缺少 prompt' })
  }
  if (!ARK_KEY || !ARK_IMAGE_MODEL) {
    return res.status(500).json({ ok: false, reason: '后端未配置 ARK_API_KEY / ARK_IMAGE_MODEL(见 backend/.env.example)' })
  }
  // 参考图(改图模式):登录态优先按 imageId 取归属校验过的原始外链
  let ref = legacyRef
  if (req.userId && refImageId) ref = store.getImageSource(req.userId, refImageId) || legacyRef
  try {
    const seedreamUrl = await callSeedream(prompt, ref)
    if (!req.userId) return res.json({ ok: true, url: seedreamUrl }) // 匿名:旧行为
    const img = await fetchImageBytes(seedreamUrl)
    if (!img) return res.json({ ok: true, url: seedreamUrl }) // 入库失败:降级用外链,不阻断出图
    const { id, accessKey } = store.saveImage({
      userId: req.userId,
      sessionId,
      bytes: img.buf,
      mime: img.mime,
      sourceUrl: seedreamUrl,
      prompt,
    })
    const base = `/api/images/${id}?k=${accessKey}`
    res.json({ ok: true, url: base, downloadUrl: `${base}&dl=1`, imageId: id })
  } catch (e) {
    console.error('[generate] Seedream 调用失败:', e?.message || e)
    res.status(502).json({ ok: false, reason: `生图失败:${e?.message || '请重试'}` })
  }
})

// 出图 / 下载入库图片。能力 URL:凭 access_key(k)即可读,无需登录头——便于 <img src> 与下载链接直用。
// dl=1 触发浏览器另存(Content-Disposition: attachment)。
app.get('/api/images/:id', (req, res) => {
  const img = store.getImageForServe(req.params.id, (req.query.k ?? '').toString())
  if (!img) return res.status(404).json({ ok: false, reason: '图片不存在或无权访问' })
  res.setHeader('Content-Type', img.mime)
  res.setHeader('Cache-Control', 'private, max-age=31536000')
  if (req.query.dl) {
    const ext = img.mime.includes('png') ? 'png' : 'jpg'
    res.setHeader('Content-Disposition', `attachment; filename="saydraw-${req.params.id.slice(0, 8)}.${ext}"`)
  }
  res.end(img.bytes)
})

const server = app.listen(PORT, () => {
  console.log(`语音造图后端已启动:http://localhost:${PORT}`)
  if (!ARK_KEY || !ARK_MODEL) {
    console.warn('⚠️  未检测到 ARK_API_KEY / ARK_MODEL,/api/chat 将返回配置错误。请复制 .env.example 为 .env 并填写。')
  }
  if (!QINIU_AI_KEY) {
    console.warn('ℹ️  未检测到 QINIU_AI_KEY,云端流式语音识别关闭;前端将回退浏览器 Web Speech。')
  }
})
attachAsrProxy(server) // 挂载 /api/asr/stream WebSocket 代理
