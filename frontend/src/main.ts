import './style.css'
import { ASR } from './asr'
import { Conversation } from './chat'
import { TTS } from './tts'

const chatEl = document.getElementById('chat') as HTMLDivElement
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

// ---- 最终图片覆盖层 ----
function showResultImage(url: string, caption: string): void {
  resultImg.src = url
  resultCaption.textContent = `🎨 ${caption}　|　说「返回」或点击任意处继续`
  resultOverlay.classList.remove('hidden')
}
function hideResultImage(): void {
  resultOverlay.classList.add('hidden')
  resultImg.removeAttribute('src')
}
resultOverlay.addEventListener('click', hideResultImage)

// ---- 文生图(prompt 由对话产出,已含风格)----
async function generate(
  prompt: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const resp = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
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
    showImage: showResultImage,
    hideImage: hideResultImage,
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
