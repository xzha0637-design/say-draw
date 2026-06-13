// 云端流式 ASR 采集端(七牛云 AI 流式语音识别,WebSocket)。
// 与 ./asr 的 Web Speech 版【同接口】(start/stop/listening + 同一组回调),main 可二选一,其余代码不变。
// 为什么要它:Web Speech 在 Chrome 走 Google 云端、内地直连即挂,且 Safari/Firefox 不支持;
//   云端 ASR 把识别收回自己后端,跨浏览器、内地可用,且为构音障碍等非标准发音留出后续调优空间。
//
// 数据流:Web Audio 采集 PCM → 降采样 16k 单声道 Int16 → 浏览器 WS 推到后端 /api/asr/stream
//   → 后端按七牛二进制协议转发 → 服务端回【累计文本】→ 本端按「文本停更 900ms」切句:
//   增量上屏(onInterim)、停更即整句(onFinal)。Key 与二进制协议都在后端,浏览器只推裸 PCM、收 {text}。
//
// barge-in:朗读(TTS)期间由 main 调 setMuted(true) 暂停上送(避免把扬声器回声送去识别);
//   此间用本地能量检测「用户开口」→ onBargeIn(),由 main 打断 TTS 并解除静音,随即恢复上送。
import type { ASRCallbacks } from './asr'
import { micErrorMessage } from './asr'

const TARGET_RATE = 16000
const FRAME = 4096 // ScriptProcessor 缓冲样本数(~85ms @48k)
const FINAL_SILENCE_MS = 1200 // 文本停止变化超过此值 → 收一句(onFinal);留足停顿,避免说一半被切
const BARGE_RMS = 0.02 // 静音(TTS)期间判定「用户开口」的能量阈值
const BARGE_FRAMES = 4 // 连续多少帧超阈值才算真打断(滤掉回声瞬态)

function getAC(): typeof AudioContext | null {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/**
 * 云端流式识别。接口与 ASR 对齐:start/stop/listening + ASRCallbacks。
 * onInterim 给当前句增量(实时字幕);onFinal 给整句;onRecognizing 在收到首个文本时为 true、收句后为 false。
 * setMuted(true) 期间不上送音频(供 TTS 朗读防回环),但仍监听能量以支持 barge-in。
 */
export class CloudASR {
  private readonly cb: ASRCallbacks
  private wantListening = false
  private muted = false
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private sink: GainNode | null = null
  private ws: WebSocket | null = null
  private rate = 48000
  // 切句状态:服务端文本是累计的,committedLen 之前的已作为 final 交付
  private committedLen = 0
  private lastText = ''
  private silenceTimer: number | undefined
  private bargeFrames = 0

  constructor(cb: ASRCallbacks = {}) {
    this.cb = cb
  }

  static get supported(): boolean {
    return !!navigator.mediaDevices?.getUserMedia && !!getAC() && typeof WebSocket !== 'undefined'
  }

  get listening(): boolean {
    return this.wantListening
  }

  /** TTS 朗读期间静音上送(防把扬声器回声送去识别),仍保留 barge-in 能量监听。 */
  setMuted(m: boolean): void {
    this.muted = m
    if (m) this.bargeFrames = 0
  }

  async start(): Promise<void> {
    if (this.wantListening) return
    const AC = getAC()
    if (!AC) {
      this.cb.onError?.('当前浏览器不支持 Web Audio,无法采集麦克风。')
      return
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      })
    } catch (e) {
      this.cb.onError?.(micErrorMessage(e))
      return
    }
    this.ctx = new AC()
    this.rate = this.ctx.sampleRate
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(FRAME, 1, 1)
    this.node.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0))
    // 静音 gain 隔断:部分浏览器不接 destination 不触发回调,但直接接会把麦克风原声放出来啸叫。
    this.sink = this.ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node)
    this.node.connect(this.sink)
    this.sink.connect(this.ctx.destination)
    this.wantListening = true
    this.connect()
    this.cb.onListeningChange?.(true)
  }

  stop(): void {
    this.wantListening = false
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.node?.disconnect()
    this.source?.disconnect()
    this.sink?.disconnect()
    this.node = this.source = this.sink = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
    this.ws = null
    this.resetSegment()
    this.cb.onListeningChange?.(false)
  }

  private resetSegment(): void {
    this.committedLen = 0
    this.lastText = ''
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
  }

  /** 连接后端 WS;断线时若仍在聆听则退避重连。 */
  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/asr/stream`)
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev) => this.onServerMessage(ev.data)
    ws.onclose = () => {
      if (this.ws === ws && this.wantListening) {
        this.resetSegment()
        window.setTimeout(() => {
          if (this.wantListening) this.connect()
        }, 800)
      }
    }
    ws.onerror = () => {
      this.cb.onError?.('云端识别连接异常,正在重连…(或检查后端与七牛云配置)')
    }
    this.ws = ws
  }

  /** 服务端消息:{reset} 重置切句基线;{text} 累计文本 → 增量上屏 + 停更切句。 */
  private onServerMessage(raw: unknown): void {
    let msg: { text?: string; reset?: boolean }
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : '')
    } catch {
      return
    }
    if (msg.reset) {
      this.resetSegment()
      return
    }
    const text = typeof msg.text === 'string' ? msg.text : ''
    // 关键:只有文本【变化】才算「还在说」并重置静音计时;空文本或与上次相同(说完后服务端会
    // 持续重发同一句)直接忽略,让静音计时得以触发收句 —— 否则永远停在「识别中」不落地。
    if (!text || text === this.lastText) return
    this.lastText = text
    if (text.length < this.committedLen) this.committedLen = 0 // 服务端换句重置了文本
    const interim = text.slice(this.committedLen)
    this.cb.onRecognizing?.(true)
    if (interim) this.cb.onInterim?.(interim)
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = window.setTimeout(() => {
      const seg = text.slice(this.committedLen).trim()
      this.committedLen = text.length
      this.cb.onRecognizing?.(false)
      if (seg) this.cb.onFinal?.(seg)
    }, FINAL_SILENCE_MS)
  }

  /** 每帧:静音期监听能量做 barge-in;否则降采样为 16k Int16 推给后端。 */
  private onAudio(frame: Float32Array): void {
    if (!this.wantListening) return
    if (this.muted) {
      let sum = 0
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
      if (Math.sqrt(sum / frame.length) >= BARGE_RMS) {
        if (++this.bargeFrames >= BARGE_FRAMES) {
          this.bargeFrames = 0
          this.cb.onBargeIn?.()
        }
      } else {
        this.bargeFrames = 0
      }
      return
    }
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const pcm = floatToInt16(downsample(frame, this.rate, TARGET_RATE))
    this.ws.send(pcm.buffer)
  }
}

// ───────────────────────── PCM 工具 ─────────────────────────

/** 最近邻降采样到目标采样率(ASR 精度足够)。 */
function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return input
  const ratio = inRate / outRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)]
  return out
}

/** Float32(-1..1) → 16-bit PCM。 */
function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}
