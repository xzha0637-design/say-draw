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
   * 窗口:朗读中,或结束后 3s 内(识别器对朗读期音频的 final 结果会迟到 1~3s)。
   * 判法:字符重合率,而非子串精确匹配——同音字会让回声与原文字面不一致(画/花),
   * 但大半字符仍会命中;听到的内容 ≥50% 字符出现在刚朗读文本里 → 判为回声。
   * 代价(有意取舍):朗读窗口内,若用户指令的用字与刚朗读内容高度重合,可能被误吞;
   * 打断时用与播报不同的措辞(如"停""不对")即可,执行类指令等半秒说效果最好。
   */
  isEcho(heard: string): boolean {
    if (!this.lastNorm) return false
    if (!this.speakingNow && Date.now() - this.endedAt > 3000) return false
    const h = norm(heard)
    if (h.length < 2) return true // 朗读窗口内的超短碎片不值得打断,当回声丢弃
    const chars = new Set(this.lastNorm)
    let hit = 0
    for (const c of h) if (chars.has(c)) hit++
    return hit / h.length >= 0.5
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
