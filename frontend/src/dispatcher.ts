import type { Command } from './commands'

type SlowResp = { ok: true; command: Command } | { ok: false; reason: string }
export type GenResult = { ok: true; url: string } | { ok: false; reason: string }

export interface DispatcherUI {
  /** 展示一行最终反馈(执行结果 / 错误)。 */
  showResult: (text: string) => void
  /** 解析进行中显示「理解中…」。 */
  setPending: (on: boolean) => void
  /** 朗读一句话(生成状态等)。 */
  speak: (text: string) => void
  /** 展示生成的写实大图(覆盖层)。 */
  showImage: (url: string, caption: string) => void
  /** 收起生成结果,回到画布。 */
  hideImage: () => void
}

/**
 * 指令调度器:纯 LLM 解析。
 * 所有语音指令都交后端豆包(/api/parse)解析成结构化指令,前端不做规则预判
 * ——避免规则"边界条件"误伤(如把"想画"误判成"改/删 N 号");规则快路待后续完善再加回。
 * 解析结果:generate 走异步生图分支,其余交执行引擎渲染。
 */
export class Dispatcher {
  private imageShown = false

  constructor(
    private readonly execute: (cmd: Command) => string,
    private readonly ui: DispatcherUI,
    private readonly generate?: (prompt: string) => Promise<GenResult>,
  ) {}

  async handle(text: string): Promise<void> {
    // 结果图展示期间:任意指令先收起回画布;「返回 / 关闭」则仅收起
    if (this.imageShown) {
      this.imageShown = false
      this.ui.hideImage()
      if (/^(返回|关闭|继续编辑|重新编辑|回去|退出)/.test(text)) return
    }

    // 纯 LLM:所有指令都交后端豆包解析
    this.ui.setPending(true)
    let resp: SlowResp
    try {
      resp = await this.slowParse(text)
    } catch {
      this.ui.showResult(`「${text}」—— 后端未连上?纯 LLM 解析依赖后端(cd backend && npm run dev)`)
      return
    } finally {
      this.ui.setPending(false)
    }

    if (!resp.ok) {
      this.ui.showResult(`「${text}」—— ${resp.reason}`)
      return
    }
    const cmd = resp.command
    if (cmd.action === 'generate') {
      await this.runGenerate(cmd.prompt, text)
    } else {
      this.ui.showResult(`「${text}」→ ${this.execute(cmd)}`)
    }
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
