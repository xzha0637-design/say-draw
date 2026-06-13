import './style.css'
import { ASR, type ASRCallbacks } from './asr'
import { CloudASR } from './cloud-asr'
import { Conversation, type GenResult, type Scene, type SceneChanges, type Snapshot, type VersionView } from './chat'
import { TTS } from './tts'
import * as auth from './auth'
import * as sessions from './sessions'

const chatEl = document.getElementById('chat') as HTMLDivElement
const sceneEl = document.getElementById('scene') as HTMLElement
const versionsEl = document.getElementById('versions') as HTMLDivElement
const micBtn = document.getElementById('mic-btn') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLDivElement
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement
const resultOverlay = document.getElementById('result-overlay') as HTMLDivElement
const resultImg = document.getElementById('result-img') as HTMLImageElement
const resultCaption = document.getElementById('result-caption') as HTMLDivElement
// 登录与会话管理 UI
const authOverlay = document.getElementById('auth-overlay') as HTMLDivElement
const authForm = document.getElementById('auth-form') as HTMLFormElement
const authUser = document.getElementById('auth-user') as HTMLInputElement
const authPass = document.getElementById('auth-pass') as HTMLInputElement
const authSubmit = document.getElementById('auth-submit') as HTMLButtonElement
const authToggle = document.getElementById('auth-toggle') as HTMLButtonElement
const authTitle = document.getElementById('auth-title') as HTMLDivElement
const authErr = document.getElementById('auth-err') as HTMLDivElement
const userTag = document.getElementById('user-tag') as HTMLSpanElement
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement
const myWorksBtn = document.getElementById('myworks-btn') as HTMLButtonElement
const drawer = document.getElementById('drawer') as HTMLDivElement
const drawerList = document.getElementById('drawer-list') as HTMLDivElement
const drawerClose = document.getElementById('drawer-close') as HTMLButtonElement

// 当前活动会话 id;所有出图与持久化都归属它
let activeSessionId: string | null = null

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
  setStatus(asr?.listening ? `🎧 在听… ${tip}` : '点击下方按钮并允许麦克风,说说你想画什么…', 'idle')
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

// ---- 放大查看覆盖层(含下载)----
function openOverlay(url: string, downloadUrl?: string): void {
  resultImg.src = url
  resultCaption.innerHTML = ''
  const dl = document.createElement('a')
  dl.className = 'overlay-dl'
  dl.href = downloadUrl || url
  dl.textContent = '⬇ 下载这张图'
  dl.setAttribute('download', '')
  dl.addEventListener('click', (e) => e.stopPropagation()) // 点下载不触发关闭
  resultCaption.appendChild(dl)
  const hint = document.createElement('div')
  hint.textContent = '点击空白处关闭'
  resultCaption.appendChild(hint)
  resultOverlay.classList.remove('hidden')
}
function closeOverlay(): void {
  resultOverlay.classList.add('hidden')
  resultImg.removeAttribute('src')
}
resultOverlay.addEventListener('click', closeOverlay)

// ---- 对话流内联图片(带版本号,点击放大,带下载按钮)----
function addImage(url: string, label?: string, downloadUrl?: string): void {
  const wrap = document.createElement('div')
  wrap.className = 'msg assistant'
  const col = document.createElement('div')
  col.className = 'img-col'
  const img = document.createElement('img')
  img.className = 'gen-img'
  img.src = url
  img.alt = '生成的图片'
  img.addEventListener('click', () => openOverlay(url, downloadUrl))
  col.appendChild(img)
  const bar = document.createElement('div')
  bar.className = 'img-cap'
  if (label) {
    const cap = document.createElement('span')
    cap.textContent = label
    bar.appendChild(cap)
  }
  const dl = document.createElement('a')
  dl.className = 'img-dl'
  dl.href = downloadUrl || url
  dl.textContent = '⬇ 下载'
  dl.setAttribute('download', '')
  bar.appendChild(dl)
  col.appendChild(bar)
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

// ---- 文生图 / 改图(登录态:带 sessionId 入库、refImageId 作改图参考)----
async function generate(prompt: string, refImageId?: string): Promise<GenResult> {
  const resp = await auth.authedFetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, sessionId: activeSessionId, ...(refImageId ? { imageId: refImageId } : {}) }),
  })
  return (await resp.json()) as GenResult
}

// ---- TTS:朗读助手回复;支持语音打断(barge-in)——朗读中用户开口即打断,回声经 isEcho 过滤 ----
const tts = new TTS({
  // 云端流式 ASR:朗读期间静音上送防回环(Web Speech 版无 setMuted,instanceof 守卫)
  onSpeakingChange: (speaking) => {
    if (asr instanceof CloudASR) asr.setMuted(speaking)
  },
})

// ---- 会话快照防抖持久化到服务端(每次状态变化触发,合并 600ms 内的多次写)----
let saveTimer: number | undefined
let pendingSnap: Snapshot | null = null
function schedulePersist(snap: Snapshot): void {
  pendingSnap = snap
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    if (activeSessionId && pendingSnap) void sessions.saveSession(activeSessionId, pendingSnap)
    pendingSnap = null
  }, 600)
}

// ---- 会话控制器(带记忆 + 反问 + 生成 + 服务端持久化)----
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
  {
    persist: schedulePersist,
    onNewSession: () => {
      tts.speak('好,新开一张')
      void startNewSession()
    },
  },
)

// ---- 语音识别(云端七牛云 ASR 优先,未配置则回退浏览器 Web Speech;两者同接口)----
const asrCallbacks: ASRCallbacks = {
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
  onRecognizing: (active) => {
    // 云端流式识别:识别中提示「识别中…」(Web Speech 版不触发此回调)
    if (active) setStatus('🎤 识别中…', 'pending')
    else idleStatus()
  },
  onBargeIn: () => {
    if (tts.speaking) tts.cancel() // 朗读中用户开口:立刻打断,随后解除静音恢复上送
  },
  onError: (msg) => setStatus(msg, 'pending'),
}
let asr: ASR | CloudASR

const GREETING =
  '你好!想画什么?说说看 —— 比如「我想要一只柴犬」。我会帮你把风格、背景、用途聊清楚,你说「可以了」我就生成。'
function greetIfEmpty(): void {
  if (conversation.snapshot().history.length === 0) addMessage('assistant', GREETING)
}

// ---- 会话切换 / 新建 / 列表 ----
async function startNewSession(): Promise<void> {
  const conv = await sessions.createSession()
  if (!conv) return
  activeSessionId = conv.id
  conversation.hydrate(conv)
  greetIfEmpty()
  closeDrawer()
}
async function switchToSession(id: string): Promise<void> {
  const conv = await sessions.loadSession(id)
  if (!conv) return
  activeSessionId = conv.id
  conversation.hydrate(conv)
  greetIfEmpty()
  closeDrawer()
}

function openDrawer(): void {
  drawer.classList.remove('hidden')
  void refreshDrawer()
}
function closeDrawer(): void {
  drawer.classList.add('hidden')
}
async function refreshDrawer(): Promise<void> {
  drawerList.innerHTML = '正在加载…'
  const list = await sessions.listSessions()
  drawerList.innerHTML = ''
  if (list.length === 0) {
    drawerList.textContent = '还没有作品,关掉这里说「画一只猫」就开始了。'
    return
  }
  for (const s of list) {
    const row = document.createElement('div')
    row.className = 'drawer-item' + (s.id === activeSessionId ? ' active' : '')
    const meta = document.createElement('button')
    meta.className = 'drawer-open'
    meta.innerHTML =
      `<span class="d-title">${escapeHtml(s.title || '新会话')}</span>` +
      `<span class="d-sub">${s.versionCount} 张 · ${fmtTime(s.updatedAt)}</span>`
    meta.addEventListener('click', () => void switchToSession(s.id))
    const del = document.createElement('button')
    del.className = 'drawer-del'
    del.textContent = '🗑'
    del.title = '删除这段会话'
    del.addEventListener('click', async () => {
      if (!confirm(`删除「${s.title || '新会话'}」?其图片也会一并删除。`)) return
      await sessions.deleteSession(s.id)
      if (s.id === activeSessionId) await startNewSession()
      else void refreshDrawer()
    })
    row.appendChild(meta)
    row.appendChild(del)
    drawerList.appendChild(row)
  }
}
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---- 登录态引导:登录后载入会话,未登录显示登录框 ----
async function bootstrapAfterLogin(): Promise<void> {
  authOverlay.classList.add('hidden')
  userTag.textContent = '👤 ' + (auth.getUsername() || '')
  const list = await sessions.listSessions()
  if (list.length > 0) await switchToSession(list[0].id)
  else await startNewSession()
}
function showLogin(): void {
  activeSessionId = null
  authOverlay.classList.remove('hidden')
  authErr.textContent = ''
  authUser.value = ''
  authPass.value = ''
}
auth.setUnauthorizedHandler(showLogin)

// ---- 登录 / 注册表单 ----
let authMode: 'login' | 'register' = 'login'
function syncAuthMode(): void {
  const reg = authMode === 'register'
  authTitle.textContent = reg ? '注册新账号' : '登录'
  authSubmit.textContent = reg ? '注册并进入' : '登录'
  authToggle.textContent = reg ? '已有账号?去登录' : '没有账号?去注册'
  authErr.textContent = ''
}
authToggle.addEventListener('click', () => {
  authMode = authMode === 'login' ? 'register' : 'login'
  syncAuthMode()
})
authForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const u = authUser.value.trim()
  const p = authPass.value
  if (!u || !p) {
    authErr.textContent = '请输入用户名和密码'
    return
  }
  authSubmit.disabled = true
  const r = authMode === 'register' ? await auth.register(u, p) : await auth.login(u, p)
  authSubmit.disabled = false
  if (!r.ok) {
    authErr.textContent = r.reason
    return
  }
  await bootstrapAfterLogin()
})

logoutBtn.addEventListener('click', () => {
  auth.clearSession()
  clearChat()
  conversation.hydrate({ history: [], scene: null, versions: [], currentIndex: -1 })
  showLogin()
})
myWorksBtn.addEventListener('click', openDrawer)
drawerClose.addEventListener('click', closeDrawer)
resetBtn.addEventListener('click', () => void startNewSession())

// 启动:有令牌直接进,否则显示登录框
syncAuthMode()
if (auth.getToken()) void bootstrapAfterLogin()
else showLogin()

// 选择识别后端:七牛云云端 ASR(已配置)优先 → 否则浏览器 Web Speech → 都不行则禁用麦克风
async function initASR(): Promise<void> {
  // 对比/调试开关:?asr=web 强制浏览器 Web Speech;?asr=cloud 强制七牛云流式;缺省自动(云端已配置则用云端)
  const force = new URLSearchParams(location.search).get('asr')
  let useCloud = false
  if (force === 'web') useCloud = false
  else if (force === 'cloud') useCloud = CloudASR.supported
  else if (CloudASR.supported) {
    try {
      const r = await fetch('/api/asr/status')
      useCloud = (await r.json())?.enabled === true
    } catch {
      useCloud = false
    }
  }
  asr = useCloud ? new CloudASR(asrCallbacks) : new ASR(asrCallbacks)
  micBtn.title = useCloud ? '识别引擎:七牛云流式 ASR' : '识别引擎:浏览器 Web Speech'
  console.log(`[ASR] 识别引擎 = ${useCloud ? 'cloud 七牛云流式' : 'web 浏览器 Web Speech'}${force ? ' (?asr= 强制)' : ' (自动)'}`)
  if (!useCloud && !ASR.supported) {
    micBtn.disabled = true
    micBtn.textContent = '浏览器不支持语音'
    setStatus('未配置云端识别,且当前浏览器不支持 Web Speech;请配置七牛云 ASR,或用 Chrome / Edge 打开。', 'pending')
    return
  }
  micBtn.addEventListener('click', () => {
    if (asr.listening) asr.stop()
    else void asr.start()
  })
}
void initASR()
