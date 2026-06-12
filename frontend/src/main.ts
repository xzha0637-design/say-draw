import Konva from 'konva'
import './style.css'
import { ASR } from './asr'
import { Dispatcher } from './dispatcher'
import { Executor } from './executor'
import { SceneStore } from './scene'
import { TTS } from './tts'

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

const store = new SceneStore()
const executor = new Executor(stage, layer, store)

window.addEventListener('resize', () => {
  stage.width(container.clientWidth)
  stage.height(container.clientHeight)
  centerHint()
  executor.render()
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

// 生成结果覆盖层(写实大图)
const resultOverlay = document.getElementById('result-overlay') as HTMLDivElement
const resultImg = document.getElementById('result-img') as HTMLImageElement
const resultCaption = document.getElementById('result-caption') as HTMLDivElement

function showResultImage(url: string, caption: string): void {
  resultImg.src = url
  resultCaption.textContent = `🎨 ${caption}　|　说「返回」继续编辑`
  resultOverlay.classList.remove('hidden')
}
function hideResultImage(): void {
  resultOverlay.classList.add('hidden')
  resultImg.removeAttribute('src')
}

// 画布构图 → 一句"方位参考",让生成大图大致跟随语音摆放(矢量做构图,渲染做效果)
function describeLayout(): string {
  const objs = store.all()
  if (objs.length === 0) return ''
  const names = [
    ['左上', '正上', '右上'],
    ['左侧', '中央', '右侧'],
    ['左下', '正下', '右下'],
  ]
  const spots = objs.map((o) => {
    const c = o.attrs.center
    const col = c.x < 0.34 ? 0 : c.x > 0.66 ? 2 : 1
    const row = c.y < 0.34 ? 0 : c.y > 0.66 ? 2 : 1
    return names[row][col]
  })
  return `参考构图(可不严格遵循):${spots.join('、')}方位各有一个主体元素`
}

// 调用后端 Seedream 文生图;把语音描述 + 画布构图拼成最终 prompt
async function generate(
  prompt: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const layout = describeLayout()
  const finalPrompt = layout ? `${prompt}。${layout}` : prompt
  const resp = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: finalPrompt }),
  })
  return (await resp.json()) as { ok: true; url: string } | { ok: false; reason: string }
}

// 双路调度:规则快路 → 豆包慢路兜底
const dispatcher = new Dispatcher(
  (cmd) => {
    const feedback = executor.execute(cmd)
    if (hint.visible()) {
      hint.visible(false)
      layer.draw()
    }
    tts.speak(feedback)
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
    speak: (text) => tts.speak(text),
    showImage: showResultImage,
    hideImage: hideResultImage,
  },
  generate,
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

// 语音反馈:朗读执行结果;播报期间静麦,避免反馈被自己听成新指令
const tts = new TTS({
  onSpeakingChange: (speaking) => asr.setMuted(speaking),
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
