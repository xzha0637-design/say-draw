// 对话式造图的前端控制器:维护多轮会话(带记忆),调用后端 /api/chat,
// 助手既可继续追问(chat),也可在信息足够时触发文生图(generate)。
//
// 记忆:① 会话内——history[] 累积每一轮,整段随每次请求发给豆包,模型记得聊过什么;
//      ② 跨刷新——history 持久化到 localStorage,刷新/重开页面后自动恢复并重放气泡。

export type ChatRole = 'user' | 'assistant'
export interface ChatMsg {
  role: ChatRole
  content: string
}

type ChatResp =
  | { ok: true; action: 'chat'; reply: string }
  | { ok: true; action: 'generate'; reply: string; prompt: string }
  | { ok: false; reason: string }

export type GenResult = { ok: true; url: string } | { ok: false; reason: string }

export interface ChatUI {
  /** 往对话区追加一条气泡,返回该气泡元素(便于后续更新文案,如"生成中→已生成")。 */
  addMessage: (role: ChatRole, text: string) => HTMLElement
  /** 清空对话区所有气泡。 */
  clear: () => void
  /** 思考/生成进行中提示。 */
  setPending: (on: boolean, label?: string) => void
  /** 朗读一句话(助手回复 / 状态)。 */
  speak: (text: string) => void
  /** 展示最终生成的图片(覆盖层)。 */
  showImage: (url: string, caption: string) => void
  /** 收起图片,回到对话。 */
  hideImage: () => void
}

const STORAGE_KEY = 'saydraw-chat-history'
const MAX_STORED = 60 // 持久化保留的最近条数(防无限增长)
const MAX_SENT = 20 // 每次发给模型的最近条数(控制延迟/成本;前端仍留全量用于展示)
const RESET_RE = /^(清空对话|清空记忆|重新开始|重新来过|重置对话|换个新对话|新对话)$/

/**
 * 会话控制器:语音文本进 → 多轮对话出。
 * 助手判断该继续聊还是该生成(缺风格/背景/用途会主动反问);
 * 会话带记忆并持久化,刷新后仍记得聊过的内容。
 */
export class Conversation {
  private history: ChatMsg[] = []
  private imageShown = false

  constructor(
    private readonly ui: ChatUI,
    private readonly generate: (prompt: string) => Promise<GenResult>,
  ) {
    this.history = this.load()
  }

  /** 重放已恢复的历史气泡(页面加载后由 main 调用一次);无历史返回 false。 */
  replay(): boolean {
    if (this.history.length === 0) return false
    for (const m of this.history) this.ui.addMessage(m.role, m.content)
    return true
  }

  async handle(text: string): Promise<void> {
    const t = text.trim()
    if (!t) return

    // 元命令:清空记忆、从头开始
    if (RESET_RE.test(t)) {
      this.reset()
      const msg = '好的,我们从头开始 —— 你想画点什么?'
      this.ui.addMessage('assistant', msg)
      this.history.push({ role: 'assistant', content: msg })
      this.persist()
      this.ui.speak(msg)
      return
    }

    // 看图状态下:任意话先收起回到对话;「返回 / 关闭」则仅收起、不当新消息
    if (this.imageShown) {
      this.imageShown = false
      this.ui.hideImage()
      if (/^(返回|关闭|回去|退出)$/.test(t)) return
    }

    this.ui.addMessage('user', t)
    this.history.push({ role: 'user', content: t })
    this.persist()

    this.ui.setPending(true, '🤔 豆包思考中…')
    let resp: ChatResp
    try {
      resp = await this.chat()
    } catch {
      this.ui.setPending(false)
      const err = '后端没连上?对话依赖后端(cd backend && npm run dev)'
      this.ui.addMessage('assistant', err)
      return
    }
    this.ui.setPending(false)

    if (!resp.ok) {
      this.ui.addMessage('assistant', resp.reason)
      this.ui.speak(resp.reason)
      return
    }

    this.ui.addMessage('assistant', resp.reply)
    this.history.push({ role: 'assistant', content: resp.reply })
    this.persist()
    this.ui.speak(resp.reply)

    if (resp.action === 'generate') await this.runGenerate(resp.prompt)
  }

  /** 触发文生图,并在同一条气泡里更新状态。 */
  private async runGenerate(prompt: string): Promise<void> {
    const tip = this.ui.addMessage('assistant', `🎨 正在生成…\n${prompt}`)
    this.ui.setPending(true, '🎨 正在生成图片…(约十几秒)')
    try {
      const r = await this.generate(prompt)
      this.ui.setPending(false)
      if (r.ok) {
        this.ui.showImage(r.url, prompt)
        this.imageShown = true
        tip.textContent = '🎨 已生成 ✓(说「返回」继续聊,或直接说怎么改)'
      } else {
        tip.textContent = `生成失败:${r.reason}`
        this.ui.speak('生成失败了')
      }
    } catch {
      this.ui.setPending(false)
      tip.textContent = '生成失败,后端是否已启动并配好生图模型?'
    }
  }

  /** 清空记忆:历史、本地存储、对话区全清。 */
  private reset(): void {
    this.history = []
    this.imageShown = false
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* localStorage 不可用时忽略 */
    }
    this.ui.hideImage()
    this.ui.clear()
  }

  private async chat(): Promise<ChatResp> {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: this.history.slice(-MAX_SENT) }),
    })
    return (await resp.json()) as ChatResp
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.history.slice(-MAX_STORED)))
    } catch {
      /* 容量满 / 隐私模式:静默降级为仅会话内记忆 */
    }
  }

  private load(): ChatMsg[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return []
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return []
      return arr.filter(
        (m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string',
      )
    } catch {
      return []
    }
  }
}
