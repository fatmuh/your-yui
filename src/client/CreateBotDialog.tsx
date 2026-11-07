import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useAnimatedDialog } from './useAnimatedDialog'
import { ApiError, createBot } from './api.ts'
import { DEFAULT_BOT_PERSONA, type BotDto } from '../shared/app.ts'
import './create-bot.css'

// Multi-bot harness: the dialog OWNS the POST /api/bots call (SettingsDialog
// pattern — api helper + failure surfaced in a role="status" region, the
// dialog stays open so nothing typed is lost). Bots are server entities now:
// no avatar/shape/color pickers (no new avatar system), name + persona only.
// The persona textarea prefills DEFAULT_BOT_PERSONA so "just a name" still
// produces a personal assistant, and editing it shows exactly what will
// replace the engine system prompt.

const MAX_NAME_CHARS = 64
const MAX_PERSONA_CHARS = 8000

type Props = { onClose: () => void; onCreated: (bot: BotDto) => void }
export function CreateBotDialog({ onClose, onCreated }: Props) {
  const { dialogRef, close } = useAnimatedDialog(true, onClose)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])
  const [name, setName] = useState('')
  const [persona, setPersona] = useState(DEFAULT_BOT_PERSONA)
  const [status, setStatus] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (!name.trim() || submitting) return
    setSubmitting(true)
    setStatus('')
    try {
      const bot = await createBot({ name: name.trim(), persona })
      void close(() => onCreated(bot))
    } catch (error) {
      setSubmitting(false)
      setStatus(error instanceof ApiError && error.code === 'unauthorized'
        ? 'Session expired. Sign in again.'
        : error instanceof ApiError
          ? error.message
          : 'Could not create the bot. Check your connection and try again.')
    }
  }

  return <dialog ref={dialogRef} className="create-bot-dialog t-modal" aria-labelledby="create-bot-title" aria-describedby="create-bot-demo" onCancel={event => { event.preventDefault(); void close() }} onClick={event => {
    if (event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void close()
  }}>
    <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <header className="create-bot-header"><h2 id="create-bot-title">Create New Bot</h2><button type="button" aria-label="Close Create New Bot" onClick={() => void close()}><X size={20} /></button></header>
      <div className="create-bot-body">
        <label className="sr-only" htmlFor="bot-name">Name your bot</label>
        <input ref={nameRef} id="bot-name" name="bot-name" autoFocus autoComplete="off" maxLength={MAX_NAME_CHARS} required placeholder="Name your bot" value={name} onChange={event => setName(event.target.value)} />
        <label className="create-bot-field-label" htmlFor="bot-persona">Persona — the bot's full system prompt</label>
        <textarea id="bot-persona" name="bot-persona" rows={6} maxLength={MAX_PERSONA_CHARS} value={persona} onChange={event => setPersona(event.target.value)} aria-describedby="create-bot-demo" />
        <p id="create-bot-demo" className="sr-only">Creates a bot on your account. Its persona fully replaces the default system prompt; leave it as is for a personal assistant.</p>
        {status && <p role="status" className="create-bot-status">{status}</p>}
      </div>
      <footer className="create-bot-footer"><button type="button" className="bot-cancel" onClick={() => void close()}>Cancel</button><button type="submit" className="bot-create" disabled={!name.trim() || submitting}>{submitting ? 'Creating…' : 'Create'}</button></footer>
    </form>
  </dialog>
}
