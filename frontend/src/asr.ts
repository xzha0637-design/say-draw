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
  /** 云端识别上传/识别期间为 true(Web Speech 版不触发);供界面显示「识别中…」。 */
  onRecognizing?: (active: boolean) => void
  /** 云端流式版:朗读(静音)期间检测到用户开口 → 用于打断 TTS(Web Speech 版不触发)。 */
  onBargeIn?: () => void
}

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** 把 getUserMedia 的具体异常翻译成可操作的中文提示。 */
export function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  switch (name) {
    case 'NotAllowedError':
      return '麦克风权限被拒绝:① 地址栏 🔒 → 麦克风 = 允许;② macOS 系统设置 → 隐私与安全性 → 麦克风 → 勾选本浏览器(改后需重启浏览器)'
    case 'NotFoundError':
      return '没有检测到麦克风设备'
    case 'NotReadableError':
      return '麦克风被其它应用占用,关闭占用它的程序后重试'
    case 'SecurityError':
      return '当前地址不安全:语音功能仅在 http://localhost:5173(或 https)下可用'
    default:
      return `无法访问麦克风:${name || String(e)}`
  }
}

/**
 * 语音识别封装(Web Speech API)。
 * - 中文识别(zh-CN),连续模式 + 静音自动重启 → 实现"持续聆听"。
 * - 区分临时(interim)与最终(final)结果。
 */
export class ASR {
  private recognition: SpeechRecognitionLike | null = null
  private wantListening = false
  private spawnedAt = 0
  private failStreak = 0
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

  async start(): Promise<void> {
    if (this.wantListening) return
    const Ctor = getCtor()
    if (!Ctor) {
      this.cb.onError?.('当前浏览器不支持 Web Speech API,请使用 Chrome 或 Edge。')
      return
    }
    // 预检:直接向浏览器要一次麦克风再立刻释放。SpeechRecognition 自身把"站点权限/系统权限/
    // 识别服务不可用"全报成 not-allowed,无从排查;getUserMedia 能给出具体原因,且顺带完成授权弹窗。
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
    } catch (e) {
      this.cb.onError?.(micErrorMessage(e))
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
      this.failStreak = 0 // 有结果到达 = 链路正常,清空失败计数
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
      // 不可自愈的三类错误:先归位聆听状态,再给可操作提示——顺序很重要,
      // 反过来的话 onListeningChange 触发的默认文案会立刻覆盖错误提示,用户只见按钮弹回、不见原因。
      // 预检已确认麦克风可用,所以这里的 not-allowed 指的是"识别服务"而非麦克风权限:
      // Chrome 的语音识别走 Google 云端服务,网络不可达(如内地直连)即失败,Edge(微软服务)不受影响。
      if (e.error === 'network') {
        // 网络抖动很常见:先靠 onend 的退避重启静默自愈,连续 3 次失败才停下并指引,
        // 避免一次瞬断就把用户踢出聆听模式
        this.failStreak++
        if (this.failStreak < 3) return
        this.wantListening = false
        this.cb.onListeningChange?.(false)
        this.cb.onError?.('连不上语音识别服务(network):Chrome 的识别依赖 Google 服务,请检查网络/代理,或改用 Microsoft Edge')
        return
      }
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantListening = false
        this.cb.onListeningChange?.(false)
        this.cb.onError?.('麦克风正常,但浏览器的语音识别服务不可用:Chrome 识别依赖 Google 服务;请检查网络/代理,或改用 Microsoft Edge')
        return
      }
      // no-speech / aborted 属正常静默;其余上报
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.cb.onError?.(`语音识别错误:${e.error}`)
      }
    }

    rec.onend = () => {
      if (!this.wantListening) return
      // 浏览器静音后会自动结束,立即重启实现持续聆听;
      // 但若距启动过近(快速失败,如 network 错误)则退避重启,避免死循环刷错
      if (Date.now() - this.spawnedAt < 1000) {
        window.setTimeout(() => {
          if (this.wantListening) this.spawn(Ctor)
        }, 800)
      } else {
        this.spawn(Ctor)
      }
    }

    this.recognition = rec
    this.spawnedAt = Date.now()
    try {
      rec.start()
    } catch {
      // 已在运行时 start() 会抛错,忽略
    }
  }
}
