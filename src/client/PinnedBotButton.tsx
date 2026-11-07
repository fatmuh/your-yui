import type { ReactNode } from 'react'
import { useLongPressMenu } from './useLongPressMenu'

type Props = {
  id: string
  title: string
  active: boolean
  onSelect: () => void
  onMenu: (element: HTMLButtonElement, x: number, y: number) => void
  children: ReactNode
}
export function PinnedBotButton({ id, title, active, onSelect, onMenu, children }: Props) {
  const longPress = useLongPressMenu(onMenu)
  return <button {...longPress} type="button" className="bot-shortcut" data-chat-id={id} aria-label={`Open ${title} chat`} aria-current={active ? 'page' : undefined} aria-haspopup="menu" onClick={onSelect} onKeyDown={event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      onMenu(event.currentTarget, rect.left, rect.bottom)
    }
  }}>{children}</button>
}
