import './style.css'
import { ASR } from './asr'
import { Conversation, type VersionView } from './chat'
import { TTS } from './tts'

const chatEl = document.getElementById('chat') as HTMLDivElement
const versionsEl = document.getElementById('versions') as HTMLDivElement
const micBtn = document.getElementById('mic-btn') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLDivElement
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement
const resultOverlay = document.getElementById('result-overlay') as HTMLDivElement
const resultImg = document.getElementById('result-img') as HTMLImageElement
const resultCaption = document.getElementById('result-caption') as HTMLDivElement

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
  return s.replace(/[&<>"]/g, (c) => map[c])
}

// ---- 对话区 ----
function addMessage(role: 'user' | 'assistant', text: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = `msg ${role}`
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text
  wrap.appendChild(bubble)
  chatEl.appendChild(wrap)
  chatEl.scrollTop = chatEl.scrollHeight
  return bubble
}
function clearChat(): void {
  chatEl.innerHTML = ''
}

// ---- 底部状态条(复用为:识别中字幕 / 思考中 / 错误)----
function setStatus(text: string, kind: 'idle' | 'interim' | 'pending'): void {
  statusEl.classList.toggle('empty', kind === 'idle')
  if (kind === 'interim') statusEl.innerHTML = `<span class="interim">${escapeHtml(text)}</span>`
  else statusEl.textContent = text
}
function idleStatus(): void {
  setStatus(
    asr.listening ? '🎧 在听… 说你想画什么、或怎么改' : '点击下方按钮并允许麦克风,说说你想画什么…',
    'idle',
  )
}

// ---- 放大查看覆盖层 ----
function openOverlay(url: string): void {
  resultImg.src = url
  resultCaption.textContent = '点击任意处关闭'
  resultOverlay.classList.remove('hidden')
}
function closeOverlay(): void {
  resultOverlay.classList.add('hidden')
  resultImg.removeAttribute('src')
}
resultOverlay.addEventListener('click', closeOverlay)

// ---- 对话流内联图片(带版本号,点击放大)----
function addImage(url: string, label?: string): void {
  const wrap = document.createElement('div')
  wrap.className = 'msg assistant'
  const col = document.createElement('div')
  col.className = 'img-col'
  const img = document.createElement('img')
  img.className = 'gen-img'
  img.src = url
  img.alt = '生成的图片'
  img.addEventListener('click', () => openOverlay(url))
  col.appendChild(img)
  if (label) {
    const cap = document.createElement('div')
    cap.className = 'img-cap'
    cap.textContent = label
    col.appendChild(cap)
  }
  wrap.appendChild(col)
  chatEl.appendChild(wrap)
  chatEl.scrollTop = chatEl.scrollHeight
}

// ---- 底部版本条(检查点总览;点击或语音「回到第N张」跳转)----
function renderVersions(items: VersionView[]): void {
  versionsEl.innerHTML = ''
  versionsEl.classList.toggle('empty', items.length === 0)
  if (items.length === 0) return
  const title = document.createElement('span')
  title.className = 'ver-title'
  title.textContent = '版本'
  versionsEl.appendChild(title)
  for (const it of items) {
    const thumb = document.createElement('button')
    thumb.className = 'ver-thumb' + (it.current ? ' current' : '')
    thumb.title = `第${it.n}张${it.starred ? ' ⭐' : ''} —— 点击或说「回到第${it.n}张」从这张继续`
    const img = document.createElement('img')
    img.src = it.url
    thumb.appendChild(img)
    const tag = document.createElement('span')
    tag.className = 'ver-n'
    tag.textContent = (it.starred ? '⭐' : '') + it.n
    thumb.appendChild(tag)
    thumb.addEventListener('click', () => conversation.jumpTo(it.n))
    versionsEl.appendChild(thumb)
  }
}

// ---- 文生图 / 改图(带 image 即编辑当前图)----
async function generate(
  prompt: string,
  image?: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const resp = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(image ? { prompt, image } : { prompt }),
  })
  return (await resp.json()) as { ok: true; url: string } | { ok: false; reason: string }
}

// ---- TTS:朗读助手回复;朗读期间静麦,避免把自己的话听成新输入 ----
const tts = new TTS({ onSpeakingChange: (speaking) => asr.setMuted(speaking) })

// ---- 会话控制器(带记忆 + 反问 + 生成)----
const conversation = new Conversation(
  {
    addMessage,
    clear: clearChat,
    setPending: (on, label) => {
      if (on) setStatus(label ?? '处理中…', 'pending')
      else idleStatus()
    },
    speak: (t) => tts.speak(t),
    addImage,
    renderVersions,
  },
  generate,
)

// ---- 语音识别 ----
const asr = new ASR({
  onListeningChange: (listening) => {
    micBtn.classList.toggle('listening', listening)
    micBtn.textContent = listening ? '⏹ 停止聆听' : '🎤 开始聆听'
    idleStatus()
  },
  onInterim: (text) => setStatus(text, 'interim'),
  onFinal: (text) => void conversation.handle(text),
  onError: (msg) => setStatus(msg, 'pending'),
})

// 恢复历史对话(记忆);无历史则给一句引导语
if (!conversation.replay()) {
  addMessage(
    'assistant',
    '你好!想画什么?说说看 —— 比如「我想要一只柴犬」。我会帮你把风格、背景、用途聊清楚,你说「可以了」我就生成。',
  )
}

resetBtn.addEventListener('click', () => void conversation.handle('新对话'))

if (!ASR.supported) {
  micBtn.disabled = true
  micBtn.textContent = '浏览器不支持语音'
  setStatus('当前浏览器不支持 Web Speech API,请用 Chrome 或 Edge 打开。', 'pending')
} else {
  micBtn.addEventListener('click', () => {
    if (asr.listening) asr.stop()
    else asr.start()
  })
}
