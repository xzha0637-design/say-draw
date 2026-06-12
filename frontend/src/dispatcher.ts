import { parse } from './parser'
import type { Command } from './commands'

type SlowResp = { ok: true; command: Command } | { ok: false; reason: string }

export interface DispatcherUI {
  /** 展示一行最终反馈(执行结果或错误)。 */
  showResult: (text: string) => void
  /** 慢路进行中显示「理解中…」。 */
  setPending: (on: boolean) => void
}

/**
 * 指令调度器:双路路由。
 * - 快路:本地规则解析,命中即执行(零延迟)。
 * - 慢路:规则解析不出时,转后端 /api/parse(豆包)兜底口语化 / 复杂指令。
 * 后续 PR 将在此扩展对象模型、意图路由、TTS 与反问会话。
 */
export class Dispatcher {
  constructor(
    private readonly execute: (cmd: Command) => string,
    private readonly ui: DispatcherUI,
  ) {}

  async handle(text: string): Promise<void> {
    const fast = parse(text)
    if (fast.ok) {
      this.ui.showResult(`「${text}」→ ${this.execute(fast.command)}`)
      return
    }
    // 规则没解析出来 → 交豆包慢路兜底
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

  private async slowParse(text: string): Promise<SlowResp> {
    const resp = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    return (await resp.json()) as SlowResp
  }
}
