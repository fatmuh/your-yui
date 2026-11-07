import { useEffect, useRef } from 'react'
import { ArrowUp, X } from 'lucide-react'
import { voiceTime, type useVoiceRecorder } from './useVoiceRecorder'
import './voice-note.css'

export function VoiceNoteControls({ voice, onCancel }: { voice: ReturnType<typeof useVoiceRecorder>; onCancel: () => void }) {
  const stopRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (voice.phase === 'recording') stopRef.current?.focus()
    else if (voice.phase === 'requesting') cancelRef.current?.focus()
  }, [voice.phase])
  const working = voice.phase === 'requesting' || voice.phase === 'stopping'
  return <div className="voice-composer" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCancel() } }}>
    <button type="button" ref={cancelRef} className="composer-icon voice-cancel" aria-label="Cancel voice note" onClick={onCancel}><X size={18} /></button>
    <div className="voice-content">
      <span className="voice-listening">{voice.phase === 'requesting' ? 'Allow microphone access…' : voice.phase === 'stopping' ? 'Sending voice note…' : 'Listening…'}</span>
    </div>
    <div className="voice-actions">
      {voice.phase === 'recording' && <div className="voice-recording-pill">
        <button type="button" ref={stopRef} aria-label="Stop and send voice note" onClick={voice.stop}><span /></button>
        <span className="voice-timer">{voiceTime(voice.seconds)}</span>
        <span className="voice-level" aria-hidden="true">{[0.45, 0.85, 1, 0.6].map((scale, index) => <i key={index} style={{ height: `${3 + voice.level * scale * 5}px` }} />)}</span>
      </div>}
      <button type="button" className="composer-icon send-button voice-send" aria-label="Send voice note" disabled={working} onClick={voice.send}><ArrowUp strokeWidth={2.4} /></button>
    </div>
  </div>
}
