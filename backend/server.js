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

// 对话式造图的系统提示:多轮聊清画面 → 满意后触发生成
const CHAT_SYSTEM_PROMPT = `你是「语音造图」的 AI 助手。用户只能用语音和你交流,你们一起把"想要的画面"聊清楚,满意后由你触发生成最终图片。

每轮只输出一个 JSON 对象,二选一:
- 继续聊: {"action":"chat","reply":"…"}
- 去生成: {"action":"generate","reply":"…","prompt":"…"}

怎么聊:
- 帮用户把画面说清楚,逐步确认四件事:① 画什么(主体/内容)② 风格(写实照片/卡通/油画/水彩/像素/线描…)③ 背景或场景 ④ 用途(头像/海报/壁纸/插画/表情…)。
- 若关键信息缺失(尤其风格、背景、用途),用 chat 友好、口语地一次问清缺的一两项,别一口气问太多。
- 用户补充或修改时,在心里更新完整画面;可简短复述你的理解让用户确认。
- 已经够清楚、且用户表示满意或让你开始("可以了""就这样""生成吧""开始画""好了"等)→ 输出 generate。
- 用户看到图后继续提要求(改颜色/换背景/换风格…)→ 视为对画面的修改,信息够就再 generate,否则先 chat 问清。

generate 时:
- reply: 一句简短口语确认(例:"好嘞,这就给你生成~")。
- prompt: 给文生图模型的【完整中文描述】,综合多轮对话:主体 + 风格 + 背景 + 关键细节 + 色调/氛围,尽量具体、可成画;不要包含对话语气词。

注意:
- reply 会被朗读出来,要短、自然、像真人。
- 严格只输出一个 JSON,不要解释、不要 markdown、不要多余文字。`

/** 对话式造图:把多轮消息发给豆包,强制 JSON 输出 {action, reply, prompt?}。 */
async function callDoubaoChat(messages) {
  const resp = await fetch(`${ARK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ARK_KEY}`,
    },
    body: JSON.stringify({
      model: ARK_MODEL,
      messages: [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...messages],
      response_format: { type: 'json_object' },
      temperature: 0.6, // 对话比解析更需要自然,略升温
      max_tokens: 1200,
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
  try {
    const out = await callDoubaoChat(messages)
    const reply = typeof out?.reply === 'string' && out.reply.trim() ? out.reply.trim() : '嗯,你再多说说想要的画面?'
    if (out?.action === 'generate') {
      const prompt = typeof out?.prompt === 'string' ? out.prompt.trim() : ''
      if (prompt) return res.json({ ok: true, action: 'generate', reply, prompt })
    }
    res.json({ ok: true, action: 'chat', reply })
  } catch (e) {
    console.error('[chat] 豆包调用失败:', e?.message || e)
    res.status(502).json({ ok: false, reason: '对话失败,请重试' })
  }
})

// 画面描述 → 最终图片(Seedream 文生图);prompt 由对话产出,已含风格,直接用
app.post('/api/generate', async (req, res) => {
  const prompt = (req.body?.prompt ?? '').toString().trim()
  if (!prompt) {
    return res.status(400).json({ ok: false, reason: '缺少 prompt' })
  }
  if (!ARK_KEY || !ARK_IMAGE_MODEL) {
    return res.status(500).json({ ok: false, reason: '后端未配置 ARK_API_KEY / ARK_IMAGE_MODEL(见 backend/.env.example)' })
  }
  try {
    const url = await callSeedream(prompt)
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
