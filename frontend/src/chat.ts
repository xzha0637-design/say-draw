// 对话式造图 + 语音迭代改图的前端控制器。
// 流程:语音 → /api/chat(带记忆 + 是否已有图)→ 助手判断 chat/generate/edit:
//   chat   = 继续聊(反问/澄清);
//   generate = 全新生成;
//   edit   = 以"当前图"为参考改图(改色/换背景/增减元素…,保持其余一致)。
// 维护一个图片栈:栈顶=当前图,支持「撤销」回上一张。
//
// 记忆:① 会话内——history[] 随每次请求发给豆包;② 跨刷新——history 持久化 localStorage。
// (图片 URL 是签名会过期,不持久化;刷新后文字对话恢复,图片为本会话内有效。)

export type ChatRole = 'user' | 'assistant'
export interface ChatMsg {
  role: ChatRole
  content: string
}

type ChatResp =
  | { ok: true; action: 'chat'; reply: string }
  | { ok: true; action: 'generate' | 'edit'; reply: string; prompt: string }
  | { ok: false; reason: string }

export type GenResult = { ok: true; url: string } | { ok: false; reason: string }

export interface ChatUI {
  /** 追加一条文字气泡,返回元素(便于后续更新)。 */
  addMessage: (role: ChatRole, text: string) => HTMLElement
  /** 在对话流中追加一张图片(点击可放大)。 */
  addImage: (url: string) => void
  /** 清空对话区。 */
  clear: () => void
  /** 思考 / 生成 / 改图 进行中提示。 */
  setPending: (on: boolean, label?: string) => void
  /** 朗读一句话。 */
  speak: (text: string) => void
}

const STORAGE_KEY = 'saydraw-chat-history'
const MAX_STORED = 60
const MAX_SENT = 20
const RESET_RE = /^(清空对话|清空记忆|重新开始|重新来过|重置对话|换个新对话|新对话)$/
const UNDO_RE = /^(撤销|上一张|退回|回到上一张|返回上一张|还原)$/

/**
 * 会话控制器:语音文本进 → 聊 / 生成 / 改图 出。
 * 助手判断该继续聊、生成新图、还是改当前图(缺信息会反问);带对话记忆与图片栈。
 */
export class Conversation {
  private history: ChatMsg[] = []
  private imageStack: string[] = [] // 生成 / 改过的图 URL,栈顶 = 当前图

  constructor(
    private readonly ui: ChatUI,
    private readonly generate: (prompt: string, image?: string) => Promise<GenResult>,
  ) {
    this.history = this.load()
  }

  private get currentImage(): string | null {
    return this.imageStack.length ? this.imageStack[this.imageStack.length - 1] : null
  }

  /** 重放已恢复的历史气泡(图片不持久化,故只重放文字);无历史返回 false。 */
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

    // 图片撤销:回到上一张(需已有图)
    if (this.currentImage && UNDO_RE.test(t)) {
      if (this.imageStack.length >= 2) {
        this.imageStack.pop()
        this.ui.addMessage('assistant', '↩️ 已退回上一张')
        this.ui.addImage(this.currentImage as string)
        this.ui.speak('已退回上一张')
      } else {
        const msg = '没有更早的版本了'
        this.ui.addMessage('assistant', msg)
        this.ui.speak(msg)
      }
      return
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

    if (resp.action === 'generate') await this.runGenerate(resp.prompt, false)
    else if (resp.action === 'edit') await this.runGenerate(resp.prompt, true)
  }

  /** 生成(全新)或编辑(以当前图为参考)。 */
  private async runGenerate(prompt: string, isEdit: boolean): Promise<void> {
    const editing = isEdit && !!this.currentImage // edit 但还没图 → 退化为全新生成
    this.ui.setPending(true, editing ? '🎨 改图中…(约十几秒)' : '🎨 生成中…(约十几秒)')
    try {
      const r = await this.generate(prompt, editing ? (this.currentImage as string) : undefined)
      this.ui.setPending(false)
      if (r.ok) {
        this.imageStack.push(r.url)
        this.ui.addImage(r.url)
      } else {
        this.ui.addMessage('assistant', `生成失败:${r.reason}`)
        this.ui.speak('生成失败了')
      }
    } catch {
      this.ui.setPending(false)
      this.ui.addMessage('assistant', '生成失败,后端是否已启动并配好生图模型?')
    }
  }

  /** 清空记忆:历史、本地存储、图片栈、对话区全清。 */
  private reset(): void {
    this.history = []
    this.imageStack = []
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* localStorage 不可用时忽略 */
    }
    this.ui.clear()
  }

  private async chat(): Promise<ChatResp> {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: this.history.slice(-MAX_SENT), hasImage: !!this.currentImage }),
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
