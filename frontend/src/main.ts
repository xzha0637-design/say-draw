import Konva from 'konva'
import './style.css'
import { ASR } from './asr'
import { Dispatcher } from './dispatcher'
import { Executor } from './executor'

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

// 用法提示(首次成功绘图后隐藏)
const hint = new Konva.Text({
  text: 'say-draw\n试着说:「画一个红色的圆」',
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

const executor = new Executor(stage, layer)

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

// 双路调度:规则快路 → 豆包慢路兜底
const dispatcher = new Dispatcher(
  (cmd) => {
    const feedback = executor.execute(cmd)
    if (hint.visible()) {
      hint.visible(false)
      layer.draw()
    }
    return feedback
  },
  {
    showResult: (text) => showTranscript(text, false),
    setPending: (on) => {
      if (on) {
        transcriptEl.classList.remove('empty')
        transcriptEl.textContent = '🤔 豆包理解中…'
      }
    },
  },
)

const asr = new ASR({
  onListeningChange: (listening) => {
    micBtn.classList.toggle('listening', listening)
    micBtn.textContent = listening ? '⏹ 停止聆听' : '🎤 开始聆听'
  },
  onInterim: (text) => showTranscript(text, true),
  onFinal: (text) => void dispatcher.handle(text),
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
