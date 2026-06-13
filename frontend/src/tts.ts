interface TTSCallbacks {
  /** 朗读开始 / 结束时回调(界面状态用)。 */
  onSpeakingChange?: (speaking: boolean) => void
}

/** 回声比对用:去掉空白与常见标点,只留正文。 */
function norm(s: string): string {
  return s.replace(/[\s,.;:!?，。;:!?、~～'"'"「」《》()()\-—–…·]/g, '')
}

/**
 * 语音反馈(Web Speech 的 SpeechSynthesis)。
 * - 朗读执行结果,让纯语音用户无需看屏也能确认操作。
 * - 支持语音打断(barge-in):朗读期间麦克风不静音,用户开口即可打断;
 *   配套 isEcho() 供外部过滤"麦克风听到的其实是 TTS 自己的声音",避免自我打断与回环。
 */
export class TTS {
  private readonly cb: TTSCallbacks
  private speakingNow = false
  // 持有当前 utterance 引用:绕开 Chrome 下 utterance 被 GC 导致 onend 不触发的问题。
  private current: SpeechSynthesisUtterance | null = null
  // 看门狗:Chrome 在 cancel() 后立刻 speak() 偶发不触发任何事件,按时长估算兜底归位状态
  private watchdog: number | null = null
  // 最近一次朗读的归一化文本与结束时间,供回声判定
  private lastNorm = ''
  private endedAt = 0

  constructor(cb: TTSCallbacks = {}) {
    this.cb = cb
  }

  static get supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
  }

  get speaking(): boolean {
    return this.speakingNow
  }

  /**
   * 回声判定:识别到的文本是否只是"刚朗读内容"被麦克风听回来了。
   * 仅在朗读中或刚结束的尾音窗口内生效;以归一化后的互为子串近似判断。
   */
  isEcho(heard: string): boolean {
    if (!this.lastNorm) return false
    if (!this.speakingNow && Date.now() - this.endedAt > 1500) return false
    const h = norm(heard)
    if (!h) return true // 朗读窗口内的纯标点/空白碎片,当回声丢弃
    return this.lastNorm.includes(h) || h.includes(this.lastNorm)
  }

  /** 朗读一段文本;打断上一句以保证播报的是最新反馈。 */
  speak(text: string): void {
    if (!TTS.supported || !text.trim()) return
    // 先清当前引用并强制归位:即使上一句的 onend 被 Chrome 吞掉,状态也不会卡在"朗读中"
    this.current = null
    window.speechSynthesis.cancel()
    this.setSpeaking(false)
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
    this.lastNorm = norm(text)
    window.speechSynthesis.speak(u)
    this.armWatchdog(u, text.length)
  }

  /** 立即停止朗读(语音打断入口)。 */
  cancel(): void {
    this.current = null
    if (TTS.supported) window.speechSynthesis.cancel()
    this.setSpeaking(false)
  }

  /** 事件丢失兜底:按"起步延迟 + 每字时长"估算,超时强制归位。 */
  private armWatchdog(u: SpeechSynthesisUtterance, chars: number): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog)
    const ms = Math.min(20000, 2000 + chars * 300)
    this.watchdog = window.setTimeout(() => {
      if (this.current === u) {
        this.current = null
        this.setSpeaking(false)
      }
    }, ms)
  }

  private setSpeaking(v: boolean): void {
    if (this.speakingNow === v) return
    this.speakingNow = v
    if (!v) this.endedAt = Date.now()
    this.cb.onSpeakingChange?.(v)
  }
}
