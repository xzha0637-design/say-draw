// Web Speech API 在各浏览器下类型不统一,这里做最小可用声明
interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [index: number]: SpeechRecognitionResultLike }
}
interface SpeechRecognitionErrorEventLike {
  error: string
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

export interface ASRCallbacks {
  onInterim?: (text: string) => void
  onFinal?: (text: string) => void
  onListeningChange?: (listening: boolean) => void
  onError?: (message: string) => void
}

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * 语音识别封装(Web Speech API)。
 * - 中文识别(zh-CN),连续模式 + 静音自动重启 → 实现"持续聆听"。
 * - 区分临时(interim)与最终(final)结果。
 */
export class ASR {
  private recognition: SpeechRecognitionLike | null = null
  private wantListening = false
  private readonly cb: ASRCallbacks

  constructor(cb: ASRCallbacks = {}) {
    this.cb = cb
  }

  static get supported(): boolean {
    return getCtor() !== null
  }

  get listening(): boolean {
    return this.wantListening
  }

  start(): void {
    if (this.wantListening) return
    const Ctor = getCtor()
    if (!Ctor) {
      this.cb.onError?.('当前浏览器不支持 Web Speech API,请使用 Chrome 或 Edge。')
      return
    }
    this.wantListening = true
    this.cb.onListeningChange?.(true)
    this.spawn(Ctor)
  }

  stop(): void {
    this.wantListening = false
    this.cb.onListeningChange?.(false)
    this.recognition?.stop()
  }

  private spawn(Ctor: SpeechRecognitionCtor): void {
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const text = result[0].transcript
        if (result.isFinal) {
          const finalText = text.trim()
          if (finalText) this.cb.onFinal?.(finalText)
        } else {
          interim += text
        }
      }
      if (interim) this.cb.onInterim?.(interim)
    }

    rec.onerror = (e) => {
      // no-speech / aborted 属正常静默;其余上报
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.cb.onError?.(`语音识别错误:${e.error}`)
      }
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantListening = false
        this.cb.onListeningChange?.(false)
      }
    }

    rec.onend = () => {
      // 浏览器静音后会自动结束;只要仍想聆听就重启,实现持续聆听
      if (this.wantListening) this.spawn(Ctor)
    }

    this.recognition = rec
    try {
      rec.start()
    } catch {
      // 已在运行时 start() 会抛错,忽略
    }
  }
}
