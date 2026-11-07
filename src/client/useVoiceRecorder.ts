import { useEffect, useRef, useState } from 'react'
import { acquireMic } from './micLock'

export type VoiceNote = { blob: Blob; duration: number }
type Phase = 'idle' | 'requesting' | 'recording' | 'stopping'
type Session = {
  recorder: MediaRecorder; stream: MediaStream; releaseMic: () => void; chunks: Blob[]; started: number
  timer?: ReturnType<typeof setInterval>; context?: AudioContext; duration?: number
}
export const voiceTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

/** Records only after an explicit start action. Never uploads microphone data. */
export function useVoiceRecorder(conversationId: string, onSend: (note: VoiceNote, conversationId: string) => void) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const session = useRef<Session | null>(null)
  const generation = useRef(0)
  const busy = useRef(false)
  const sendRef = useRef(onSend)
  sendRef.current = onSend

  function release(current: Session) {
    clearInterval(current.timer)
    current.releaseMic()
    if (current.context) void current.context.close().catch(() => {})
  }
  function dispose() {
    ++generation.current
    const current = session.current
    session.current = null
    if (current) {
      current.recorder.ondataavailable = null
      current.recorder.onstop = null
      current.recorder.onerror = null
      if (current.recorder.state !== 'inactive') current.recorder.stop()
      release(current)
    }
    busy.current = false
  }
  function cancel() {
    dispose()
    setPhase('idle'); setSeconds(0); setLevel(0); setError('')
  }
  useEffect(() => {
    cancel()
    return dispose
    // The conversation owns any unfinished recording; switching releases the microphone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  function finish() {
    const current = session.current
    if (!current || current.recorder.state !== 'recording') return
    current.duration = (performance.now() - current.started) / 1000
    setPhase('stopping')
    // Leave the microphone tracks running until onstop. Stopping them first can drop the final chunk.
    try { current.recorder.stop() } catch {
      cancel()
      setError('Recording stopped unexpectedly. Check your microphone and record again, or type a message instead.')
    }
  }
  async function start() {
    if (busy.current) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice recording is unavailable in this browser. Use a supported browser over HTTPS, or type a message instead.')
      return
    }
    busy.current = true
    const token = ++generation.current
    const chatId = conversationId
    setError(''); setPhase('requesting'); setSeconds(0); setLevel(0)
    let handle: Awaited<ReturnType<typeof acquireMic>> | undefined
    try {
      handle = await acquireMic()
      const stream = handle.stream
      if (token !== generation.current) { handle.release(); return }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type))
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      const current: Session = { recorder, stream, releaseMic: handle.release, chunks: [], started: performance.now() }
      session.current = current
      recorder.ondataavailable = event => { if (event.data.size) current.chunks.push(event.data) }
      recorder.onerror = () => {
        if (token !== generation.current) return
        cancel()
        setError('Recording stopped unexpectedly. Check your microphone and record again, or type a message instead.')
      }
      recorder.onstop = () => {
        if (token !== generation.current) return
        const duration = current.duration ?? (performance.now() - current.started) / 1000
        release(current)
        session.current = null
        const blob = new Blob(current.chunks, { type: recorder.mimeType || current.chunks[0]?.type || 'audio/webm' })
        if (!blob.size) {
          cancel()
          setError('No audio was captured. Check your microphone and record again, or type a message instead.')
          return
        }
        cancel()
        sendRef.current({ blob, duration }, chatId)
      }
      // Level visualization is optional: recording still works if Web Audio is unavailable.
      let analyser: AnalyserNode | undefined
      try {
        const context = new AudioContext()
        current.context = context
        analyser = context.createAnalyser()
        analyser.fftSize = 256
        context.createMediaStreamSource(stream).connect(analyser)
        void context.resume().catch(() => {})
      } catch { /* Keep timer and recording controls without a meter. */ }
      const samples = new Uint8Array(256)
      current.timer = setInterval(() => {
        if (token !== generation.current) return
        setSeconds((performance.now() - current.started) / 1000)
        if (analyser && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          analyser.getByteTimeDomainData(samples)
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length)
          setLevel(Math.min(1, rms * 6))
        } else setLevel(0)
      }, 150)
      recorder.start(200)
      stream.getTracks().forEach(track => { track.onended = () => finish() })
      setPhase('recording')
    } catch (cause) {
      handle?.release()
      if (token !== generation.current) return
      cancel()
      const name = cause instanceof DOMException ? cause.name : ''
      setError(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Microphone access was blocked. Allow microphone access in your browser’s site settings and try again, or type a message instead.'
        : name === 'NotFoundError'
          ? 'No microphone was found. Connect a microphone and try again, or type a message instead.'
          : 'Unable to start recording. Check that your microphone is connected and not in use, then try again or type a message instead.')
    }
  }
  return { phase, error, seconds, level, start, cancel, stop: finish, send: finish }
}
