// 对话式造图 + 语音迭代改图 + 版本检查点。
// 流程:语音 → /api/chat(带记忆 + 是否已有图)→ 助手 chat/generate/edit:
//   chat=继续聊;generate=全新生成;edit=以"当前版本"为参考改图(保持其余一致)。
// 检查点:每次生成/改图都自动存为一个版本;可「回到第N张」跳回任意版本继续改(从任一检查点分叉),
//        「撤销」回上一张,「收藏」标记当前版本。
//
// 持久化:不再用 localStorage,而是把整段会话快照(history/scene/versions/index)经 hooks.persist
//   交给上层写入服务端(按 user_id × session_id 隔离);图片是入库的持久 URL,可长期展示与下载。

export type ChatRole = 'user' | 'assistant'
export interface ChatMsg {
  role: ChatRole
  content: string
}

/** 语义画布:当前画面的结构化场景图,模型每轮维护并完整返回,前端渲染为「画面要素板」。 */
export interface SceneElement {
  name: string
  color: string
  desc: string
  pos: string
  size: string
}
export interface Scene {
  style: string
  usage: string
  background: string
  elements: SceneElement[]
}
/** 一轮更新后,要素板需要闪烁提示的变更部分。 */
export interface SceneChanges {
  metas: ('style' | 'usage' | 'background')[]
  names: string[]
}

/** 版本条要展示的一项。 */
export interface VersionView {
  url: string
  n: number // 从 1 起的版本号
  starred: boolean
  current: boolean
}

/** 一个版本检查点:持久图片 URL + 下载链接 + 入库 id(改图作参考)+ 场景图快照。 */
export interface ImgVersion {
  url: string
  downloadUrl: string
  imageId: string
  starred: boolean
  scene: Scene | null
}

/** 会话快照:服务端持久化与跨会话切换的载体。 */
export interface Snapshot {
  history: ChatMsg[]
  scene: Scene | null
  versions: ImgVersion[]
  currentIndex: number
}

type ChatResp =
  | { ok: true; action: 'chat'; reply: string; scene?: Scene }
  | { ok: true; action: 'generate' | 'edit'; reply: string; prompt: string; scene?: Scene }
  | { ok: true; action: 'multi'; reply: string; steps: string[] }
  | { ok: false; reason: string }

export type GenResult =
  | { ok: true; url: string; downloadUrl?: string; imageId?: string }
  | { ok: false; reason: string }

export interface ChatUI {
  addMessage: (role: ChatRole, text: string) => HTMLElement
  /** 在对话流追加一张图片(label 如"第2张";点击放大;downloadUrl 给下载按钮)。 */
  addImage: (url: string, label?: string, downloadUrl?: string) => void
  /** 渲染底部版本条(检查点总览)。 */
  renderVersions: (items: VersionView[]) => void
  /** 渲染画面要素板(语义画布);changed 指明本轮变更、需闪烁的部分。 */
  renderScene: (scene: Scene | null, changed?: SceneChanges) => void
  /** 复合指令:把拆解出的步骤标签上屏,返回用于逐条点亮/打勾的更新函数。 */
  addSteps: (steps: string[]) => (i: number, state: 'active' | 'done') => void
  clear: () => void
  setPending: (on: boolean, label?: string) => void
  speak: (text: string) => void
}

/** 上层注入的持久化与会话管理钩子。 */
export interface ConversationHooks {
  /** 每次状态变化后调用:把快照交给上层(防抖)写服务端。 */
  persist: (snap: Snapshot) => void
  /** 语音「新对话」时调用:由上层新建并切换到一个全新服务端会话。 */
  onNewSession: () => void
}

const MAX_SENT = 20
const RESET_RE = /^(清空对话|清空记忆|重新开始|重新来过|重置对话|换个新对话|新对话|新会话|新建会话)$/
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
 * 状态变化经 hooks.persist 上抛由上层持久化到服务端。
 */
export class Conversation {
  private history: ChatMsg[] = []
  private versions: ImgVersion[] = []
  private currentIndex = -1
  /** 语义画布:当前场景图(随对话由模型维护,版本跳转时随快照恢复)。 */
  private scene: Scene | null = null

  constructor(
    private readonly ui: ChatUI,
    private readonly generate: (prompt: string, refImageId?: string) => Promise<GenResult>,
    private readonly hooks: ConversationHooks,
  ) {}

  private get currentImage(): string | null {
    return this.currentIndex >= 0 ? this.versions[this.currentIndex].url : null
  }
  private get currentImageId(): string | undefined {
    return this.currentIndex >= 0 ? this.versions[this.currentIndex].imageId || undefined : undefined
  }

  /** 是否已有出图版本(供界面按状态给"你可以说…"提示)。 */
  get hasVersions(): boolean {
    return this.versions.length > 0
  }

  /** 当前完整快照(供持久化与切换)。 */
  snapshot(): Snapshot {
    return {
      history: this.history,
      scene: this.scene,
      versions: this.versions,
      currentIndex: this.currentIndex,
    }
  }

  /** 载入一个会话快照并重绘界面(切换会话 / 登录后恢复)。 */
  hydrate(snap: Snapshot): void {
    this.history = Array.isArray(snap.history) ? snap.history : []
    this.versions = Array.isArray(snap.versions) ? snap.versions : []
    this.currentIndex = Number.isInteger(snap.currentIndex) ? snap.currentIndex : this.versions.length - 1
    this.scene = snap.scene ?? null
    this.ui.clear()
    for (const m of this.history) this.ui.addMessage(m.role, m.content)
    if (this.currentIndex >= 0 && this.versions[this.currentIndex]) {
      const v = this.versions[this.currentIndex]
      this.ui.addImage(v.url, `第 ${this.currentIndex + 1} 张`, v.downloadUrl)
    }
    this.ui.renderScene(this.scene)
    this.emitVersions()
  }

  /** 跳到第 n 个版本(1 起;供版本条点击或语音调用)。 */
  jumpTo(n: number): void {
    if (n < 1 || n > this.versions.length || n - 1 === this.currentIndex) return
    this.setCurrent(n - 1, `已回到第 ${n} 张,接着说怎么改`)
  }

  async handle(text: string): Promise<void> {
    const t = text.trim()
    if (!t) return

    // 快路:确定性指令本地执行,~0ms
    if (this.tryLocal(t)) return

    this.ui.addMessage('user', t)
    this.history.push({ role: 'user', content: t })
    this.persist()

    const resp = await this.requestChat()
    if (!resp) return
    if (!resp.ok) {
      this.ui.addMessage('assistant', resp.reason)
      this.ui.speak(resp.reason)
      return
    }

    // 复合指令:慢路拆解出步骤,逐条执行(每条再分发时仍先过快路)
    if (resp.action === 'multi') {
      await this.runSteps(resp.reply, resp.steps)
      return
    }
    await this.applyResponse(resp)
  }

  /** 本地快路:命中确定性指令(新对话/跳版本/收藏/撤销)则直接执行并返回 true。 */
  private tryLocal(t: string): boolean {
    // 元命令:开一段全新会话(交由上层在服务端新建并切换)
    if (RESET_RE.test(t)) {
      this.hooks.onNewSession()
      return true
    }
    // 以下版本操作都需已有图
    if (this.versions.length === 0) return false
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
      return true
    }
    // 收藏/保存当前版本为检查点
    if (STAR_RE.test(t)) {
      this.toggleStar()
      return true
    }
    // 撤销:线性回上一张
    if (UNDO_RE.test(t)) {
      if (this.currentIndex > 0) this.setCurrent(this.currentIndex - 1, '已退回上一张')
      else {
        this.ui.addMessage('assistant', '没有更早的版本了')
        this.ui.speak('没有更早的版本了')
      }
      return true
    }
    return false
  }

  /** 慢路一轮:带 pending 状态请求豆包;网络失败时提示并返回 null。 */
  private async requestChat(nosplit = false): Promise<ChatResp | null> {
    this.ui.setPending(true, '🤔 豆包思考中…')
    try {
      const resp = await this.chat(nosplit)
      this.ui.setPending(false)
      return resp
    } catch {
      this.ui.setPending(false)
      this.ui.addMessage('assistant', '后端没连上?对话依赖后端(cd backend && npm run dev)')
      return null
    }
  }

  /** 单动作响应落地:场景图 → 气泡 → 记忆 → 朗读 → 触发出图。 */
  private async applyResponse(resp: Extract<ChatResp, { ok: true }>): Promise<void> {
    if (resp.action === 'multi') return // 防御:nosplit 下后端已兜底为 chat,不应到这
    if (resp.scene) this.applyScene(resp.scene)
    this.ui.addMessage('assistant', resp.reply)
    this.history.push({ role: 'assistant', content: resp.reply })
    this.persist()
    this.ui.speak(resp.reply)

    if (resp.action === 'generate') await this.runGenerate(resp.prompt, false)
    else if (resp.action === 'edit') await this.runGenerate(resp.prompt, true)
  }

  /** 复合指令执行器:步骤标签上屏,按序执行;每条步骤先过本地快路,需要时再走豆包(nosplit)。 */
  private async runSteps(reply: string, steps: string[]): Promise<void> {
    this.history.push({ role: 'assistant', content: reply })
    this.persist()
    const mark = this.ui.addSteps(steps)
    this.ui.speak(reply)
    for (let i = 0; i < steps.length; i++) {
      mark(i, 'active')
      if (!this.tryLocal(steps[i])) {
        // 步骤入记忆但不入气泡(步骤标签已可见),模型按单步指令直接执行
        this.history.push({ role: 'user', content: steps[i] })
        const r = await this.requestChat(true)
        if (r && r.ok) await this.applyResponse(r)
        else if (r && !r.ok) {
          this.ui.addMessage('assistant', r.reason)
          this.ui.speak(r.reason)
        }
      }
      mark(i, 'done')
    }
  }

  /** 应用模型返回的新场景图:与旧场景做 diff,变更部分在要素板上闪烁。 */
  private applyScene(next: Scene): void {
    const prev = this.scene
    const changed: SceneChanges = { metas: [], names: [] }
    const METAS = ['style', 'usage', 'background'] as const
    if (prev) {
      for (const k of METAS) if (next[k] && next[k] !== prev[k]) changed.metas.push(k)
      const before = new Map(prev.elements.map((e) => [e.name, e]))
      for (const e of next.elements) {
        const p = before.get(e.name)
        if (!p || p.color !== e.color || p.desc !== e.desc || p.pos !== e.pos || p.size !== e.size)
          changed.names.push(e.name)
      }
    } else {
      for (const k of METAS) if (next[k]) changed.metas.push(k)
      changed.names = next.elements.map((e) => e.name)
    }
    this.scene = next
    this.ui.renderScene(next, changed)
  }

  private cloneScene(): Scene | null {
    return this.scene ? (JSON.parse(JSON.stringify(this.scene)) as Scene) : null
  }

  /** 生成(全新)或编辑(以当前版本为参考);成功则追加一个新版本检查点。 */
  private async runGenerate(prompt: string, isEdit: boolean): Promise<void> {
    const editing = isEdit && !!this.currentImage // edit 但还没图 → 退化为全新生成
    this.ui.setPending(true, editing ? '🎨 改图中…(约十几秒)' : '🎨 生成中…(约十几秒)')
    try {
      const r = await this.generate(prompt, editing ? this.currentImageId : undefined)
      this.ui.setPending(false)
      if (r.ok) {
        this.versions.push({
          url: r.url,
          downloadUrl: r.downloadUrl || r.url,
          imageId: r.imageId || '',
          starred: false,
          scene: this.cloneScene(),
        })
        this.currentIndex = this.versions.length - 1
        this.ui.addImage(r.url, `第 ${this.versions.length} 张`, r.downloadUrl || r.url)
        this.emitVersions()
        this.persist()
        this.ui.speak(`第 ${this.versions.length} 张好了`) // 渲染完成播报:用户未盯屏也知道画好了
      } else {
        this.ui.addMessage('assistant', `生成失败:${r.reason}`)
        this.ui.speak('生成失败了')
      }
    } catch {
      this.ui.setPending(false)
      this.ui.addMessage('assistant', '生成失败,后端是否已启动并配好生图模型?')
    }
  }

  /** 把当前指针移到 idx,展示该版本、恢复其场景图快照并刷新版本条。 */
  private setCurrent(idx: number, note: string): void {
    this.currentIndex = idx
    const v = this.versions[idx]
    this.scene = v.scene ? (JSON.parse(JSON.stringify(v.scene)) as Scene) : null
    this.ui.renderScene(this.scene)
    this.persist()
    this.ui.addMessage('assistant', `↩️ ${note}`)
    this.ui.addImage(v.url, `第 ${idx + 1} 张`, v.downloadUrl)
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
    this.persist()
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

  private async chat(nosplit = false): Promise<ChatResp> {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: this.history.slice(-MAX_SENT),
        hasImage: !!this.currentImage,
        scene: this.scene,
        nosplit,
      }),
    })
    return (await resp.json()) as ChatResp
  }

  private persist(): void {
    this.hooks.persist(this.snapshot())
  }
}
