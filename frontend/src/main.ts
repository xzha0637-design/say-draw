import Konva from 'konva'
import './style.css'
import { ASR } from './asr'

const containerId = 'canvas-container'
const container = document.getElementById(containerId) as HTMLDivElement

// 画布:铺满视口
const stage = new Konva.Stage({
  container: containerId,
  width: container.clientWidth,
  height: container.clientHeight,
})

const layer = new Konva.Layer()
stage.add(layer)

// 占位提示(后续 PR 接入绘图执行)
const hint = new Konva.Text({
  text: 'say-draw\n空画布已就绪 · 等待接入语音绘图',
  fontSize: 22,
  fontFamily: 'sans-serif',
  fill: '#cccccc',
  align: 'center',
  lineHeight: 1.5,
})

function centerHint(): void {
  hint.position({
    x: stage.width() / 2 - hint.width() / 2,
    y: stage.height() / 2 - hint.height() / 2,
  })
}

layer.add(hint)
centerHint()
layer.draw()

window.addEventListener('resize', () => {
  stage.width(container.clientWidth)
  stage.height(container.clientHeight)
  centerHint()
})

// ---- 语音识别 HUD ----
const micBtn = document.getElementById('mic-btn') as HTMLButtonElement
const transcriptEl = document.getElementById('transcript') as HTMLDivElement

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }
  return s.replace(/[&<>"]/g, (c) => map[c])
}

function showTranscript(text: string, interim: boolean): void {
  transcriptEl.classList.remove('empty')
  transcriptEl.innerHTML = interim
    ? `<span class="interim">${escapeHtml(text)}</span>`
    : escapeHtml(text)
}

const asr = new ASR({
  onListeningChange: (listening) => {
    micBtn.classList.toggle('listening', listening)
    micBtn.textContent = listening ? '⏹ 停止聆听' : '🎤 开始聆听'
  },
  onInterim: (text) => showTranscript(text, true),
  // PR2:仅把最终识别结果显示出来;后续 PR 会把它送去解析为绘图指令
  onFinal: (text) => showTranscript(text, false),
  onError: (msg) => {
    transcriptEl.classList.remove('empty')
    transcriptEl.textContent = msg
  },
})

if (!ASR.supported) {
  micBtn.disabled = true
  micBtn.textContent = '浏览器不支持语音'
  transcriptEl.classList.remove('empty')
  transcriptEl.textContent = '当前浏览器不支持 Web Speech API,请用 Chrome 或 Edge 打开。'
} else {
  micBtn.addEventListener('click', () => {
    if (asr.listening) asr.stop()
    else asr.start()
  })
}
