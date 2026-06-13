import './style.css'
import { ASR } from './asr'
import { Conversation, type Scene, type SceneChanges, type VersionView } from './chat'
import { TTS } from './tts'

const chatEl = document.getElementById('chat') as HTMLDivElement
const sceneEl = document.getElementById('scene') as HTMLElement
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
  // 语音界面没有按钮可看,按状态动态提示"现在可以说什么"
  const tip = conversation.hasVersions
    ? '试试:「把猫改成白色」「回到第 1 张」「收藏」'
    : '例:「画一只戴围巾的橙色小猫」'
  setStatus(asr.listening ? `🎧 在听… ${tip}` : '点击下方按钮并允许麦克风,说说你想画什么…', 'idle')
}

// ---- 画面要素板(语义画布的可视化:风格/背景/用途 + 元素卡片,变更闪烁)----
const META_LABEL = { style: '风格', background: '背景', usage: '用途' } as const
const COLOR_CSS: [RegExp, string][] = [
  [/红/, '#e74c3c'], [/橙|橘/, '#f59e0b'], [/黄|金/, '#f1c40f'], [/绿/, '#2ecc71'],
  [/青/, '#1abc9c'], [/蓝/, '#3498db'], [/紫/, '#9b59b6'], [/粉/, '#fd79a8'],
  [/黑/, '#2d3436'], [/白|银/, '#f5f6fa'], [/灰/, '#95a5a6'], [/棕|咖啡/, '#8d6e63'],
]
function colorCss(word: string): string | null {
  for (const [re, css] of COLOR_CSS) if (re.test(word)) return css
  return null
}

function renderScene(scene: Scene | null, changed?: SceneChanges): void {
  sceneEl.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'scene-head'
  head.textContent = '🎬 画面要素'
  sceneEl.appendChild(head)
  if (!scene || (!scene.style && !scene.usage && !scene.background && scene.elements.length === 0)) {
    const tip = document.createElement('div')
    tip.className = 'scene-tip'
    tip.textContent = '聊着聊着,这里会拼出你要的画面 —— AI 听懂了什么、还缺什么,一目了然。'
    sceneEl.appendChild(tip)
    return
  }
  for (const k of ['style', 'background', 'usage'] as const) {
    const row = document.createElement('div')
    row.className = 'scene-meta' + (changed?.metas.includes(k) ? ' flash' : '')
    const v = scene[k]
    row.innerHTML =
      `<span class="k">${META_LABEL[k]}</span>` +
      `<span class="v${v ? '' : ' unset'}">${escapeHtml(v || '待定')}</span>`
    sceneEl.appendChild(row)
  }
  scene.elements.forEach((el, i) => {
    const card = document.createElement('div')
    card.className = 'scene-card' + (changed?.names.includes(el.name) ? ' flash' : '')
    const dot = colorCss(el.color)
    const detail = [el.color, el.desc, el.pos, el.size].filter(Boolean).join(' · ')
    card.innerHTML =
      `<div class="el-head"><span class="el-n">${i + 1}</span>` +
      `<span class="el-name">${escapeHtml(el.name)}</span>` +
      (dot ? `<span class="el-dot" style="background:${dot}"></span>` : '') +
      `</div>` +
      (detail ? `<div class="el-info">${escapeHtml(detail)}</div>` : '')
    sceneEl.appendChild(card)
  })
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

// ---- 复合指令步骤标签:拆解结果上屏,执行中点亮、完成打勾 ----
function addSteps(steps: string[]): (i: number, state: 'active' | 'done') => void {
  const wrap = document.createElement('div')
  wrap.className = 'msg assistant'
  const box = document.createElement('div')
  box.className = 'steps'
  const chips = steps.map((s, i) => {
    const chip = document.createElement('span')
    chip.className = 'step-chip'
    chip.textContent = `${i + 1}. ${s}`
    box.appendChild(chip)
    return chip
  })
  wrap.appendChild(box)
  chatEl.appendChild(wrap)
  chatEl.scrollTop = chatEl.scrollHeight
  return (i, state) => {
    const chip = chips[i]
    if (!chip) return
    if (state === 'active') chip.classList.add('active')
    else {
      chip.classList.remove('active')
      chip.classList.add('done')
      chip.textContent = `✓ ${steps[i]}`
    }
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

// ---- TTS:朗读助手回复;支持语音打断(barge-in)——朗读中用户开口即打断,回声经 isEcho 过滤 ----
const tts = new TTS()

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
    renderScene,
    addSteps,
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
  onInterim: (text) => {
    if (tts.isEcho(text)) return // 麦克风听到的是 TTS 自己的声音:不上屏、更不打断
    if (tts.speaking) tts.cancel() // 语音打断:用户开口,AI 立刻闭嘴
    setStatus(text, 'interim')
  },
  onFinal: (text) => {
    if (tts.isEcho(text)) return
    if (tts.speaking) tts.cancel()
    void conversation.handle(text)
  },
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
    else void asr.start()
  })
}
