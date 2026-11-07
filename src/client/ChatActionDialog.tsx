import { useState } from 'react'
import { X } from 'lucide-react'
import { useAnimatedDialog } from './useAnimatedDialog'

type Props = { action: 'rename' | 'section' | 'delete'; title: string; onClose: () => void; onConfirm: (value: string) => void }
export function ChatActionDialog({ action, title, onClose, onConfirm }: Props) {
  const { dialogRef, close } = useAnimatedDialog(true, onClose)
  const [value, setValue] = useState(action === 'rename' ? title : '')
  const heading = action === 'rename' ? 'Rename Bot' : action === 'section' ? 'Move to new section' : `Delete “${title}”?`
  return <dialog ref={dialogRef} className="chat-action-dialog t-modal" aria-labelledby="chat-action-heading" onCancel={event => { event.preventDefault(); void close() }}>
    <form onSubmit={event => { event.preventDefault(); if (action === 'delete' || value.trim()) void close(() => onConfirm(value.trim())) }}>
      <header><h2 id="chat-action-heading">{heading}</h2><button type="button" aria-label="Close chat action" onClick={() => void close()}><X size={18} /></button></header>
      {action === 'delete' ? <p>Deleting this bot also deletes its conversation and messages from your account. This cannot be undone.</p> : <><label htmlFor="chat-action-value">{action === 'rename' ? 'Bot name' : 'Section name'}</label><input id="chat-action-value" name={action === 'rename' ? 'bot-name' : 'section-name'} autoComplete="off" autoFocus required maxLength={60} value={value} onChange={event => setValue(event.target.value)} /></>}
      <footer><button type="button" onClick={() => void close()}>Cancel</button><button className={action === 'delete' ? 'is-danger' : 'is-primary'} type="submit">{action === 'delete' ? 'Delete bot' : action === 'rename' ? 'Save name' : 'Create section'}</button></footer>
    </form>
  </dialog>
}
