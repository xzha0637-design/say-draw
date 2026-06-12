import { parse, parseAnswerTarget } from './parser'
import type { ClarifyNeed } from './parser'
import type { Command } from './commands'

type SlowResp = { ok: true; command: Command } | { ok: false; reason: string }

export interface DispatcherUI {
  /** 展示一行最终反馈(执行结果 / 错误 / 反问)。 */
  showResult: (text: string) => void
  /** 慢路进行中显示「理解中…」。 */
  setPending: (on: boolean) => void
  /** 朗读一句话(反问追问时用)。 */
  speak: (text: string) => void
}

/**
 * 指令调度器:双路路由 + 反问澄清会话(统一的「语言边界处理」入口)。
 * - 快路:本地规则解析,命中即执行(零延迟)。
 * - 慢路:规则解析不出 → 转后端 /api/parse(豆包)兜底口语化 / 复杂指令。
 * - 反问:规则识别出"要改但没说改哪个"(如「变大」)→ 语音追问「几号?」;
 *   下一句给出目标(编号 /「它」)即补齐执行,答非所问则放弃反问、按新指令处理(留"算了"退路)。
 */
export class Dispatcher {
  private pending: ClarifyNeed | null = null

  constructor(
    private readonly execute: (cmd: Command) => string,
    private readonly ui: DispatcherUI,
  ) {}

  async handle(text: string): Promise<void> {
    const fast = parse(text)

    // 1) 能解析成明确指令 → 执行(若正在反问,这等于"改主意"放弃反问)
    if (fast.ok) {
      this.pending = null
      this.ui.showResult(`「${text}」→ ${this.execute(fast.command)}`)
      return
    }

    // 2) 有改动意图但没指明对象(如「变大」)→ 发起 / 刷新反问
    if (fast.clarify) {
      this.ask(text, fast.clarify)
      return
    }

    // 3) 正在反问、这句又不是完整指令 → 试着当作"改哪个"的回答
    //    (先判 1) 才不会把「画一个圆」里的"一"误当成"1 号")
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

  private async slowParse(text: string): Promise<SlowResp> {
    const resp = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    return (await resp.json()) as SlowResp
  }
}
