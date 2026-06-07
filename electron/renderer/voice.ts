// Push-to-talk dictation. Voice is optional: when AICO_VOICE_WS points at a
// compatible local Whisper websocket, Aico captures the mic, streams 16 kHz PCM,
// and types the transcript into this widget's PTY prompt. When the websocket is
// absent, the feature reports a warning and leaves the rest of the app working.
export type TranscriptionStatus = 'idle' | 'listening' | 'processing' | 'error'

type VoiceError = 'not-allowed' | 'network' | 'voice-unavailable' | null

interface VoiceCallbacks {
  onFinalTranscript: (text: string) => void
  onStatusChange: (status: TranscriptionStatus) => void
  onError: (err: VoiceError) => void
}

class WhisperVoiceClient {
  private readonly wsUrl: string
  private readonly callbacks: VoiceCallbacks
  private ws: WebSocket | null = null
  private audioContext: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private cumulative = ''
  private recording = false

  constructor(wsUrl: string, callbacks: VoiceCallbacks) {
    this.wsUrl = wsUrl
    this.callbacks = callbacks
  }

  get isRecording(): boolean {
    return this.recording
  }

  async startRecording(): Promise<void> {
    if (this.recording) return
    if (!navigator.mediaDevices?.getUserMedia) {
      this.callbacks.onError('voice-unavailable')
      this.setStatus('error')
      return
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const separator = this.wsUrl.includes('?') ? '&' : '?'
      this.ws = new WebSocket(`${this.wsUrl}${separator}mode=transcribe`)
      this.recording = true
      this.callbacks.onError(null)
      this.setStatus('listening')

      this.ws.onopen = () => this.startAudioPump()
      this.ws.onmessage = (event) => this.handleMessage(event)
      this.ws.onerror = () => {
        this.callbacks.onError('network')
        this.setStatus('error')
        this.cleanup(true)
      }
      this.ws.onclose = () => {
        if (!this.recording) return
        this.recording = false
        this.cleanup(false)
        this.setStatus('idle')
      }
    } catch (err) {
      this.callbacks.onError(
        err instanceof DOMException && err.name === 'NotAllowedError' ? 'not-allowed' : 'network',
      )
      this.setStatus('error')
      this.cleanup(true)
    }
  }

  stopRecording(): void {
    if (!this.recording) return
    this.recording = false
    this.cleanupAudio()

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'control', action: 'stop' }))
      this.setStatus('processing')
      return
    }

    this.cleanup(true)
    this.setStatus('idle')
  }

  private startAudioPump(): void {
    if (!this.stream || !this.ws || this.ws.readyState !== WebSocket.OPEN) return

    this.audioContext = new AudioContext({ sampleRate: 16000 })
    this.source = this.audioContext.createMediaStreamSource(this.stream)
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1)

    this.processor.onaudioprocess = (event) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      const input = event.inputBuffer.getChannelData(0)
      const pcm = new Int16Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]))
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      this.ws.send(JSON.stringify({ type: 'audio', data: int16ToBase64(pcm) }))
    }

    this.source.connect(this.processor)
    this.processor.connect(this.audioContext.destination)
    this.ws.send(JSON.stringify({ type: 'control', action: 'start' }))
  }

  private handleMessage(event: MessageEvent): void {
    let msg: unknown
    try {
      msg = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (!isTranscriptMessage(msg)) return

    this.cumulative = this.cumulative ? `${this.cumulative} ${msg.data}` : msg.data
    this.callbacks.onFinalTranscript(this.cumulative)
    this.cleanup(true)
    this.setStatus('idle')
  }

  private cleanup(closeSocket: boolean): void {
    this.recording = false
    this.cleanupAudio()
    if (closeSocket) {
      this.ws?.close()
      this.ws = null
    }
  }

  private cleanupAudio(): void {
    this.stream?.getTracks().forEach((track) => {
      track.stop()
    })
    this.processor?.disconnect()
    this.source?.disconnect()
    void this.audioContext?.close()
    this.stream = null
    this.processor = null
    this.source = null
    this.audioContext = null
  }

  private setStatus(status: TranscriptionStatus): void {
    this.callbacks.onStatusChange(status)
  }
}

function isTranscriptMessage(msg: unknown): msg is { type: 'transcript'; data: string } {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    msg.type === 'transcript' &&
    'data' in msg &&
    typeof msg.data === 'string'
  )
}

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

// TranscriptionManager accumulates transcripts across utterances and reports the
// full running text each time. We only want the latest utterance, so emit the
// suffix that grew since the previous report.
export function transcriptDelta(prev: string, full: string): string {
  const delta = full.startsWith(prev) ? full.slice(prev.length) : full
  return delta.trim()
}

function setVoiceStatus(el: HTMLElement | null, status: TranscriptionStatus): void {
  if (!el) return
  const active = status === 'listening' || status === 'processing'
  el.classList.toggle('listening', status === 'listening')
  el.classList.toggle('processing', status === 'processing')
  el.hidden = !active
}

export async function wireVoice(): Promise<void> {
  const indicator = document.querySelector<HTMLElement>('.voice-indicator')
  const wsUrl = await window.aico.voice.wsUrl()

  let cumulative = ''
  const manager = new WhisperVoiceClient(wsUrl, {
    onFinalTranscript: (full) => {
      const text = transcriptDelta(cumulative, full)
      cumulative = full
      if (text) window.aico.pty.input(text)
    },
    onStatusChange: (status) => setVoiceStatus(indicator, status),
    onError: (err) => {
      if (err) console.warn('[aico] voice error:', err)
      setVoiceStatus(indicator, 'idle')
    },
  })

  const toggle = (): void => {
    if (manager.isRecording) manager.stopRecording()
    else void manager.startRecording()
  }
  // Global hotkey (via main) and the in-widget control surface both drive the same toggle.
  window.aico.voice.onToggle(toggle)
  window.addEventListener('aico:voice-toggle', toggle)
}
