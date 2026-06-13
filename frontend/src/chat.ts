// 对话式造图 + 语音迭代改图 + 版本检查点。
// 流程:语音 → /api/chat(带记忆 + 是否已有图)→ 助手 chat/generate/edit:
//   chat=继续聊;generate=全新生成;edit=以"当前版本"为参考改图(保持其余一致)。
// 检查点:每次生成/改图都自动存为一个版本;可「回到第N张」跳回任意版本继续改(从任一检查点分叉),
//        「撤销」回上一张,「收藏」标记当前版本。
//
// 记忆:history[] 随每次请求发给豆包,并持久化 localStorage(图片 URL 会过期,不持久化,仅本会话内有效)。

export type ChatRole = 'user' | 'assistant'
export interface ChatMsg {
  role: ChatRole
  content: string
}

/** 版本条要展示的一项。 */
export interface VersionView {
  url: string
  n: number // 从 1 起的版本号
  starred: boolean
  current: boolean
}

type ChatResp =
  | { ok: true; action: 'chat'; reply: string }
  | { ok: true; action: 'generate' | 'edit'; reply: string; prompt: string }
  | { ok: false; reason: string }

export type GenResult = { ok: true; url: string } | { ok: false; reason: string }

export interface ChatUI {
  addMessage: (role: ChatRole, text: string) => HTMLElement
  /** 在对话流追加一张图片(label 如"第2张";点击可放大)。 */
  addImage: (url: string, label?: string) => void
  /** 渲染底部版本条(检查点总览)。 */
  renderVersions: (items: VersionView[]) => void
  clear: () => void
  setPending: (on: boolean, label?: string) => void
  speak: (text: string) => void
}

interface ImgVersion {
  url: string
  starred: boolean
}

const STORAGE_KEY = 'saydraw-chat-history'
const MAX_STORED = 60
const MAX_SENT = 20
const RESET_RE = /^(清空对话|清空记忆|重新开始|重新来过|重置对话|换个新对话|新对话)$/
const UNDO_RE = /^(撤销|上一张|退回|回到上一张|返回上一张|还原)$/
const STAR_RE = /^(保存|收藏|记一下|存一下|存下来|保存这张|收藏这张|保存检查点|存个档)$/
// 跳到某版本:整句形如「回到第2张」「用第三张」「第3张」
const JUMP_RE = /^(?:回到|回退到|退回到|切换到|跳到|用|去)?\s*第?\s*([0-9]+|[一二两三四五六七八九十])\s*张$/
const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}
function toIndex(token: string): number | null {
  if (/^[0-9]+$/.test(token)) return parseInt(token, 10)
  return CN_NUM[token] ?? null
}

/**
 * 会话控制器:语音文本进 → 聊 / 生成 / 改图 / 版本回退 出。
 * 维护版本数组(检查点)与当前指针;edit 以当前版本为参考,可从任一版本分叉。
 */
export class Conversation {
  private history: ChatMsg[] = []
  private versions: ImgVersion[] = []
  private currentIndex = -1

  constructor(
    private readonly ui: ChatUI,
    private readonly generate: (prompt: string, image?: string) => Promise<GenResult>,
  ) {
    this.history = this.load()
  }

  private get currentImage(): string | null {
    return this.currentIndex >= 0 ? this.versions[this.currentIndex].url : null
  }

  /** 重放历史文字气泡(图片不持久化);无历史返回 false。 */
  replay(): boolean {
    if (this.history.length === 0) return false
    for (const m of this.history) this.ui.addMessage(m.role, m.content)
    return true
  }

  /** 跳到第 n 个版本(1 起;供版本条点击或语音调用)。 */
  jumpTo(n: number): void {
    if (n < 1 || n > this.versions.length || n - 1 === this.currentIndex) return
    this.setCurrent(n - 1, `已回到第 ${n} 张,接着说怎么改`)
  }

  async handle(text: string): Promise<void> {
    const t = text.trim()
    if (!t) return

    // 元命令:从头开始
    if (RESET_RE.test(t)) {
      this.reset()
      const msg = '好的,我们从头开始 —— 你想画点什么?'
      this.ui.addMessage('assistant', msg)
      this.history.push({ role: 'assistant', content: msg })
      this.persist()
      this.ui.speak(msg)
      return
    }

    // 以下版本操作都需已有图
    if (this.versions.length > 0) {
      // 回到任意版本(随时回退)
      const jm = t.match(JUMP_RE)
      if (jm) {
        const n = toIndex(jm[1])
        if (n && n >= 1 && n <= this.versions.length) this.jumpTo(n)
        else {
          const msg = `现在只有 ${this.versions.length} 张哦`
          this.ui.addMessage('assistant', msg)
          this.ui.speak(msg)
        }
        return
      }
      // 收藏/保存当前版本为检查点
      if (STAR_RE.test(t)) {
        this.toggleStar()
        return
      }
      // 撤销:线性回上一张
      if (UNDO_RE.test(t)) {
        if (this.currentIndex > 0) this.setCurrent(this.currentIndex - 1, '已退回上一张')
        else {
          this.ui.addMessage('assistant', '没有更早的版本了')
          this.ui.speak('没有更早的版本了')
        }
        return
      }
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

  /** 生成(全新)或编辑(以当前版本为参考);成功则追加一个新版本检查点。 */
  private async runGenerate(prompt: string, isEdit: boolean): Promise<void> {
    const editing = isEdit && !!this.currentImage // edit 但还没图 → 退化为全新生成
    this.ui.setPending(true, editing ? '🎨 改图中…(约十几秒)' : '🎨 生成中…(约十几秒)')
    try {
      const r = await this.generate(prompt, editing ? (this.currentImage as string) : undefined)
      this.ui.setPending(false)
      if (r.ok) {
        this.versions.push({ url: r.url, starred: false })
        this.currentIndex = this.versions.length - 1
        this.ui.addImage(r.url, `第 ${this.versions.length} 张`)
        this.emitVersions()
      } else {
        this.ui.addMessage('assistant', `生成失败:${r.reason}`)
        this.ui.speak('生成失败了')
      }
    } catch {
      this.ui.setPending(false)
      this.ui.addMessage('assistant', '生成失败,后端是否已启动并配好生图模型?')
    }
  }

  /** 把当前指针移到 idx,展示该版本并刷新版本条。 */
  private setCurrent(idx: number, note: string): void {
    this.currentIndex = idx
    this.ui.addMessage('assistant', `↩️ ${note}`)
    this.ui.addImage(this.versions[idx].url, `第 ${idx + 1} 张`)
    this.emitVersions()
    this.ui.speak(note)
  }

  /** 收藏 / 取消收藏当前版本。 */
  private toggleStar(): void {
    const v = this.versions[this.currentIndex]
    v.starred = !v.starred
    const n = this.currentIndex + 1
    this.ui.addMessage('assistant', v.starred ? `⭐ 已收藏第 ${n} 张` : `已取消收藏第 ${n} 张`)
    this.emitVersions()
    this.ui.speak(v.starred ? '已收藏' : '已取消收藏')
  }

  private emitVersions(): void {
    this.ui.renderVersions(
      this.versions.map((v, i) => ({
        url: v.url,
        n: i + 1,
        starred: v.starred,
        current: i === this.currentIndex,
      })),
    )
  }

  /** 清空记忆:历史、本地存储、版本、对话区全清。 */
  private reset(): void {
    this.history = []
    this.versions = []
    this.currentIndex = -1
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* localStorage 不可用时忽略 */
    }
    this.ui.clear()
    this.emitVersions()
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
