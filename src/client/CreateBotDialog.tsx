import { useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { BotAvatar, botShapes, type BotAppearance } from './BotAvatar'
import { useAnimatedDialog } from './useAnimatedDialog'
import './create-bot.css'

const colors = [
  { name: 'White', value: '#ffffff' }, { name: 'Brown', value: '#a8733d' },
  { name: 'Red', value: '#ff2948' }, { name: 'Orange', value: '#ff6b08' },
  { name: 'Amber', value: '#ff9c08' }, { name: 'Green', value: '#11c478' },
  { name: 'Teal', value: '#13b8a6' }, { name: 'Blue', value: '#2388ff' },
  { name: 'Purple', value: '#9355ff' }, { name: 'Pink', value: '#fa2e9b' },
  { name: 'Gray', value: '#858585' },
]

type Props = { onClose: () => void; onCreate: (name: string, appearance: BotAppearance) => void }
export function CreateBotDialog({ onClose, onCreate }: Props) {
  const { dialogRef, close } = useAnimatedDialog(true, onClose)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])
  const [name, setName] = useState('')
  const [appearance, setAppearance] = useState<BotAppearance>({ shape: 'Heart', color: '#fa2e9b' })
  return <dialog ref={dialogRef} className="create-bot-dialog t-modal" aria-labelledby="create-bot-title" aria-describedby="create-bot-demo" onCancel={event => { event.preventDefault(); void close() }} onClick={event => {
    if (event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void close()
  }}>
    <form onSubmit={event => { event.preventDefault(); if (name.trim()) void close(() => onCreate(name.trim(), appearance)) }}>
      <header className="create-bot-header"><h2 id="create-bot-title">Create New Bot</h2><button type="button" aria-label="Close Create New Bot" onClick={() => void close()}><X size={20} /></button></header>
      <div className="create-bot-body">
        <BotAvatar appearance={appearance} className="create-bot-preview" />
        <label className="sr-only" htmlFor="bot-name">Name your Bot</label>
        <input ref={nameRef} id="bot-name" name="bot-name" autoFocus autoComplete="off" maxLength={60} required placeholder="Name your Bot" value={name} onChange={event => setName(event.target.value)} />
        <fieldset className="bot-shape-picker"><legend className="sr-only">Avatar shape</legend><div className="bot-shape-options">{botShapes.map(shape => <label className="bot-shape-option" key={shape}>
          <input type="radio" name="bot-shape" value={shape} aria-label={shape} checked={appearance.shape === shape} onChange={() => setAppearance(current => ({ ...current, shape }))} />
          <span className="bot-shape-face"><BotAvatar appearance={{ ...appearance, shape }} /></span>
        </label>)}</div></fieldset>
        <fieldset className="bot-color-picker"><legend className="sr-only">Avatar color</legend><div className="bot-color-options">{colors.map(color => <label className="bot-color-option" key={color.name}>
          <input type="radio" name="bot-color" value={color.value} aria-label={color.name} checked={appearance.color === color.value} onChange={() => setAppearance(current => ({ ...current, color: color.value }))} />
          <span className="bot-color-swatch" style={{ backgroundColor: color.value }}>{appearance.color === color.value && <Check size={13} strokeWidth={2.5} aria-hidden="true" />}</span>
        </label>)}</div></fieldset>
        <p id="create-bot-demo" className="sr-only">Creates a local demo chat, not an AI-powered bot. Chats reset when you reload.</p>
      </div>
      <footer className="create-bot-footer"><button type="button" className="bot-cancel" onClick={() => void close()}>Cancel</button><button type="submit" className="bot-create" disabled={!name.trim()}>Create</button></footer>
    </form>
  </dialog>
}
