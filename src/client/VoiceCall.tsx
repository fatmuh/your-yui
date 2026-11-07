import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { MessageCircle, Mic, MicOff, Settings, X } from 'lucide-react'
import { acquireMic } from './micLock'
import { SelectMenu } from './SelectMenu'
import './voice-call.css'

type Props = {
  name: string
  avatar: ReactNode
  accent: string
  muted: boolean
  onMutedChange: (muted: boolean) => void
  onClose: () => void
}
type Phase = 'enter' | 'open' | 'closing'

function readMs(el: Element | null, name: string, fallback: number) {
  if (!el) return fallback
  const raw = getComputedStyle(el).getPropertyValue(name).trim()
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return fallback
  return raw.endsWith('ms') ? value : value * 1000
}

function reducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function VoiceCall({ name, avatar, accent, muted, onMutedChange, onClose }: Props) {
  const [settings, setSettings] = useState(false)
  const [transcript, setTranscript] = useState(false)
  const [status, setStatus] = useState<'requesting' | 'active' | 'error'>('requesting')
  const [error, setError] = useState('')
  const [level, setLevel] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [voiceName, setVoiceName] = useState('Helix')
  const [speed, setSpeed] = useState('1')
  const [language, setLanguage] = useState('Auto-detect')
  const [phase, setPhase] = useState<Phase>('enter')
  const [settled, setSettled] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const muteRef = useRef(muted)
  const endRef = useRef<HTMLButtonElement>(null)
  const voiceSelect = useRef<HTMLButtonElement>(null)
  const shellRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const closingRef = useRef(false)
  muteRef.current = muted
  onCloseRef.current = onClose
  const expanded = settings || transcript || status === 'error'

  function requestClose() {
    if (closingRef.current) return
    closingRef.current = true
    const trigger = document.querySelector('.voice-live-mic')
    if (trigger instanceof HTMLElement) trigger.focus({ preventScroll: true })
    setSettled(false)
    setPhase('closing')
  }

  useEffect(() => {
    const reduced = reducedMotion()
    if (reduced) {
      setPhase('open')
      setSettled(true)
      return
    }
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPhase('open'))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [])
  useEffect(() => {
    if (phase !== 'open' || settled) return
    const ms = readMs(shellRef.current, '--call-open-dur', 480)
    const timer = window.setTimeout(() => setSettled(true), ms)
    return () => clearTimeout(timer)
  }, [phase, settled])
  useEffect(() => {
    if (settled) endRef.current?.focus()
  }, [settled])
  useEffect(() => {
    if (settled || closingRef.current) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return
      event.preventDefault()
      requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [settled])
  useLayoutEffect(() => {
    if (phase !== 'closing') return
    const el = shellRef.current
    const reduced = reducedMotion()
    const ms = reduced ? 180 : readMs(el, '--call-close-dur', 320) + 80
    const timer = window.setTimeout(() => onCloseRef.current(), ms)
    return () => clearTimeout(timer)
  }, [phase])
  useEffect(() => {
    if (!settings || !voiceSelect.current) return
    if (matchMedia('(pointer: coarse)').matches) return
    voiceSelect.current.focus({ preventScroll: true })
  }, [settings])
  useEffect(() => {
    if (status !== 'error' || !shellRef.current || phase === 'closing') return
    shellRef.current.style.height = 'auto'
    setSettled(true)
  }, [status, phase])
  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach(track => { track.enabled = !muted })
    if (muted) setLevel(0)
  }, [muted])
  useEffect(() => {
    let cancelled = false
    let handle: Awaited<ReturnType<typeof acquireMic>> | undefined
    let context: AudioContext | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    setStatus('requesting'); setError('')
    async function connect() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported')
        handle = await acquireMic()
        if (cancelled) { handle.release(); return }
        const stream = handle.stream
        streamRef.current = stream
        stream.getTracks().forEach(track => {
          track.enabled = !muteRef.current
          track.onended = () => { setStatus('error'); setError('Microphone disconnected. Reconnect it and retry, or end the demo call.'); setLevel(0) }
        })
        setStatus('active')
        try {
          context = new AudioContext()
          const analyser = context.createAnalyser()
          analyser.fftSize = 256
          context.createMediaStreamSource(stream).connect(analyser)
          void context.resume().catch(() => {})
          const values = new Uint8Array(256)
          timer = setInterval(() => {
            if (muteRef.current || reducedMotion()) { setLevel(0); return }
            analyser.getByteTimeDomainData(values)
            const rms = Math.sqrt(values.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / values.length)
            setLevel(Math.min(1, rms * 6))
          }, 150)
        } catch { /* Optional meter; the status text still describes the microphone. */ }
      } catch (cause) {
        if (cancelled) return
        setStatus('error')
        setError(cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError')
          ? 'Microphone access was blocked. Allow it in your browser’s site settings and retry, or end the demo call.'
          : 'Unable to access the microphone. Check your microphone and browser permissions, then retry or end the demo call.')
      }
    }
    void connect()
    return () => {
      cancelled = true
      clearInterval(timer)
      handle?.release()
      streamRef.current = null
      if (context) void context.close().catch(() => {})
    }
  }, [attempt])

  const statusText = status === 'requesting' ? 'Waiting for microphone permission.' : status === 'error' ? 'Microphone unavailable.' : muted ? 'Microphone muted.' : 'Microphone on.'
  return <section ref={shellRef} className="voice-call" style={{ '--call-accent': accent } as CSSProperties} data-phase={phase} data-open={expanded || undefined} data-settled={settled || undefined} role="region" aria-label={`Voice chat with ${name}. Local demo, audio is not recorded or sent.`} onKeyDown={event => {
    if (event.key !== 'Escape') return
    event.preventDefault(); event.stopPropagation()
    if (settings || transcript) { setSettings(false); setTranscript(false); endRef.current?.focus({ preventScroll: true }) } else requestClose()
  }}>
    <div className="call-face" inert={!settled ? true : undefined}>
      <div className="call-toolbar">
        <span className="call-avatar">{avatar}</span>
        <div className="call-meter" aria-hidden="true">{Array.from({ length: 14 }, (_, index) => <i key={index} style={{ height: `${3 + level * Math.abs(Math.sin(index * 0.7)) * 8}px` }} />)}</div>
        <div className="call-buttons">
          <button type="button" aria-label="Call settings" aria-expanded={settings} aria-controls="call-settings" onClick={() => { setSettings(value => !value); setTranscript(false) }}><Settings size={18} /></button>
          <button type="button" aria-label="Show call transcript" aria-expanded={transcript} aria-controls="call-transcript" onClick={() => { setTranscript(value => !value); setSettings(false) }}><MessageCircle size={18} /></button>
          <button type="button" aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={muted} disabled={status !== 'active'} onClick={() => onMutedChange(!muted)}>{muted ? <MicOff size={18} /> : <Mic size={18} />}</button>
          <button type="button" ref={endRef} className="call-end" aria-label="End voice chat" onClick={requestClose}><X size={20} strokeWidth={2.4} /></button>
        </div>
      </div>
      <div className="t-acc" data-open={settings ? 'true' : 'false'}>
        <div id="call-settings" className="t-acc-panel">
          <div className="t-acc-panel-inner" inert={!settings ? true : undefined} aria-hidden={!settings || undefined}>
            <div className="call-settings">
              <div className="call-setting"><label id="call-voice-label" htmlFor="call-voice">Voice</label><SelectMenu controlRef={voiceSelect} id="call-voice" labelledBy="call-voice-label" variant="call" value={voiceName} onChange={setVoiceName} options={['Helix', 'Nova', 'Echo']} /></div>
              <div className="call-setting"><label id="call-speed-label" htmlFor="call-speed">Speed</label><SelectMenu id="call-speed" labelledBy="call-speed-label" variant="call" value={speed} onChange={setSpeed} options={[{ value: '0.75', label: '0.75x' }, { value: '1', label: '1x' }, { value: '1.25', label: '1.25x' }, { value: '1.5', label: '1.5x' }]} /></div>
              <div className="call-setting"><label id="call-language-label" htmlFor="call-language">Language</label><SelectMenu id="call-language" labelledBy="call-language-label" variant="call" value={language} onChange={setLanguage} options={['Auto-detect', 'English', 'Indonesian']} /></div>
              <p>Local demo. Speech is not connected.</p>
            </div>
          </div>
        </div>
      </div>
      <div className="t-acc" data-open={transcript ? 'true' : 'false'}>
        <div id="call-transcript" className="t-acc-panel">
          <div className="t-acc-panel-inner" inert={!transcript ? true : undefined} aria-hidden={!transcript || undefined}>
            <div className="call-transcript">
              <h2>Call transcript</h2>
              <p>No transcript yet. Live transcription and AI responses are not connected. You can still type in the chat.</p>
            </div>
          </div>
        </div>
      </div>
      <div className="t-acc" data-open={status === 'error' ? 'true' : 'false'}>
        <div className="t-acc-panel">
          <div className="t-acc-panel-inner" inert={status !== 'error' ? true : undefined} aria-hidden={status !== 'error' || undefined}>
            <div className="call-error" role={status === 'error' ? 'alert' : undefined}>
              <p>{error}</p>
              <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry microphone</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p className="sr-only" role="status">{statusText} Demo call. No AI is connected. Audio is not recorded or sent.</p>
  </section>
}
