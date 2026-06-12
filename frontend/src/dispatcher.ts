import { parse, parseAnswerTarget } from './parser'
import type { ClarifyNeed } from './parser'
import type { Command } from './commands'

type SlowResp = { ok: true; command: Command } | { ok: false; reason: string }
export type GenResult = { ok: true; url: string } | { ok: false; reason: string }

export interface DispatcherUI {
  /** 展示一行最终反馈(执行结果 / 错误 / 反问)。 */
  showResult: (text: string) => void
  /** 慢路进行中显示「理解中…」。 */
  setPending: (on: boolean) => void
  /** 朗读一句话(反问 / 生成状态)。 */
  speak: (text: string) => void
  /** 展示生成的写实大图(覆盖层)。 */
  showImage: (url: string, caption: string) => void
  /** 收起生成结果,回到画布。 */
  hideImage: () => void
}

/**
 * 指令调度器:双路路由 + 反问澄清会话 + 生成式收尾(统一的"理解 / 边界处理 / 产出"入口)。
 * - 快路:本地规则解析,命中即执行(零延迟)。
 * - 慢路:规则解析不出 → 转后端 /api/parse(豆包)兜底口语化 / 复杂指令。
 * - 反问:识别出"要改但没说改哪个"(如「变大」)→ 语音追问,下一句补齐;答非所问则放弃。
 * - 生成:「渲染成 …」→ 调后端 Seedream 文生图,出写实大图覆盖层;说「返回」回到画布。
 */
export class Dispatcher {
  private pending: ClarifyNeed | null = null
  private imageShown = false

  constructor(
    private readonly execute: (cmd: Command) => string,
    private readonly ui: DispatcherUI,
    private readonly generate?: (prompt: string) => Promise<GenResult>,
  ) {}

  async handle(text: string): Promise<void> {
    // 结果图展示期间:说「返回 / 关闭」收起;说其它指令也先收起,再正常处理
    if (this.imageShown) {
      this.imageShown = false
      this.ui.hideImage()
      if (/^(返回|关闭|继续编辑|重新编辑|回去|退出)/.test(text)) return
    }

    const fast = parse(text)

    // 1) 能解析成明确指令 → 执行(生成走异步分支;在反问中=放弃反问)
    if (fast.ok) {
      this.pending = null
      if (fast.command.action === 'generate') {
        await this.runGenerate(fast.command.prompt, text)
      } else {
        this.ui.showResult(`「${text}」→ ${this.execute(fast.command)}`)
      }
      return
    }

    // 2) 有改动意图但没指明对象(如「变大」)→ 发起 / 刷新反问
    if (fast.clarify) {
      this.ask(text, fast.clarify)
      return
    }

    // 3) 正在反问、这句又不是完整指令 → 试着当作"改哪个"的回答
    if (this.pending) {
      const target = parseAnswerTarget(text)
      if (target) {
        const cmd: Command = { action: 'edit', target, patch: this.pending.patch }
        this.pending = null
        this.ui.showResult(`「${text}」→ ${this.execute(cmd)}`)
        return
      }
      this.pending = null // 答非所问 → 放弃反问,转普通流程
    }

    // 4) 规则没解析出来 → 交豆包慢路兜底
    this.ui.setPending(true)
    try {
      const slow = await this.slowParse(text)
      if (slow.ok) this.ui.showResult(`「${text}」→ ${this.execute(slow.command)}`)
      else this.ui.showResult(`「${text}」—— ${slow.reason}`)
    } catch {
      this.ui.showResult(`「${text}」—— ${fast.reason}(豆包慢路不可用,后端是否已启动?)`)
    } finally {
      this.ui.setPending(false)
    }
  }

  /** 发起反问:记下待补的改动,语音 + 字幕追问改哪个。 */
  private ask(text: string, need: ClarifyNeed): void {
    this.pending = need
    const q = '要改哪一个图形?说个编号,比如「2 号」,或说「它」'
    this.ui.showResult(`「${text}」—— ${q}`)
    this.ui.speak(q)
  }

  /** 生成式收尾:把描述(+ 画布构图)渲染成写实大图。 */
  private async runGenerate(prompt: string, text: string): Promise<void> {
    if (!this.generate) {
      this.ui.showResult('生图未接入(需启动后端并配置 ARK_IMAGE_MODEL)')
      return
    }
    if (!prompt) {
      const q = '想渲染成什么画面?请说「渲染成」加描述,例如「渲染成夕阳下的湖边小屋」'
      this.ui.showResult(`「${text}」—— ${q}`)
      this.ui.speak(q)
      return
    }
    this.ui.showResult(`「${text}」→ 正在生成写实大图…(${prompt})`)
    this.ui.speak('正在生成,请稍候')
    try {
      const r = await this.generate(prompt)
      if (r.ok) {
        this.ui.showImage(r.url, prompt)
        this.imageShown = true
        this.ui.showResult(`「${text}」→ 已生成:${prompt}(说「返回」继续编辑)`)
        this.ui.speak('生成完成')
      } else {
        this.ui.showResult(`「${text}」—— 生成失败:${r.reason}`)
        this.ui.speak('生成失败')
      }
    } catch {
      this.ui.showResult(`「${text}」—— 生成失败,后端是否已启动并配置生图模型?`)
    }
  }

  private async slowParse(text: string): Promise<SlowResp> {
    const resp = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    return (await resp.json()) as SlowResp
  }
}
