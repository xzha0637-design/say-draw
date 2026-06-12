interface TTSCallbacks {
  /** 朗读开始 / 结束时回调,外部据此静麦防回环。 */
  onSpeakingChange?: (speaking: boolean) => void
}

/**
 * 语音反馈(Web Speech 的 SpeechSynthesis)。
 * - 朗读执行结果,让纯语音用户无需看屏也能确认操作。
 * - 朗读期间经 onSpeakingChange 通知外部静麦,避免"自己说的话被自己听见"的回环。
 */
export class TTS {
  private readonly cb: TTSCallbacks
  private speakingNow = false
  // 持有当前 utterance 引用:绕开 Chrome 下 utterance 被 GC 导致 onend 不触发的问题。
  private current: SpeechSynthesisUtterance | null = null

  constructor(cb: TTSCallbacks = {}) {
    this.cb = cb
  }

  static get supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
  }

  get speaking(): boolean {
    return this.speakingNow
  }

  /** 朗读一段文本;打断上一句以保证播报的是最新反馈。 */
  speak(text: string): void {
    if (!TTS.supported || !text.trim()) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'zh-CN'
    u.rate = 1.05
    // 仅响应"当前"utterance 的事件,忽略被打断的旧句回调
    u.onstart = () => {
      if (this.current === u) this.setSpeaking(true)
    }
    u.onend = () => {
      if (this.current === u) this.setSpeaking(false)
    }
    u.onerror = () => {
      if (this.current === u) this.setSpeaking(false)
    }
    this.current = u
    window.speechSynthesis.speak(u)
  }

  /** 立即停止朗读。 */
  cancel(): void {
    this.current = null
    if (TTS.supported) window.speechSynthesis.cancel()
    this.setSpeaking(false)
  }

  private setSpeaking(v: boolean): void {
    if (this.speakingNow === v) return
    this.speakingNow = v
    this.cb.onSpeakingChange?.(v)
  }
}
