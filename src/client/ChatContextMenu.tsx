import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { BellDot, Copy, EyeOff, FolderPlus, Pin, SquarePen, Trash2 } from 'lucide-react'

export type ChatAction = 'pin' | 'section' | 'unread' | 'rename' | 'copy' | 'hide' | 'delete'
export type ChatMenuTarget = { id: string; title: string; pinned?: boolean; unread?: boolean; x: number; y: number; trigger: HTMLElement }

export function ChatContextMenu({ target, onClose, onAction }: { target: ChatMenuTarget; onClose: () => void; onAction: (action: ChatAction) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const closing = useRef(false)
  const actions = [
    { id: 'pin', label: target.pinned ? 'Unpin' : 'Pin', icon: Pin },
    { id: 'section', label: 'Move to new section', icon: FolderPlus },
    { id: 'unread', label: target.unread ? 'Mark as Read' : 'Mark as Unread', icon: BellDot },
    { id: 'rename', label: 'Rename Bot', icon: SquarePen, separator: true },
    { id: 'copy', label: 'Copy conversation ID', icon: Copy, separator: true },
    { id: 'hide', label: 'Hide from sidebar', icon: EyeOff, separator: true },
    { id: 'delete', label: 'Delete', icon: Trash2 },
  ] as const

  async function close(action?: ChatAction, restore = true) {
    const menu = ref.current
    if (!menu || closing.current) return
    closing.current = true
    menu.classList.remove('is-open')
    menu.inert = true
    await Promise.allSettled(menu.getAnimations().map(a => a.finished))
    if (!menu.isConnected) return
    if (restore && target.trigger.isConnected) target.trigger.focus()
    onClose()
    if (action) onAction(action)
  }

  useLayoutEffect(() => {
    const menu = ref.current!
    const place = () => {
      menu.style.left = `${Math.max(8, Math.min(target.x, innerWidth - menu.offsetWidth - 8))}px`
      menu.style.top = `${Math.max(8, Math.min(target.y, innerHeight - menu.offsetHeight - 8))}px`
    }
    place()
    void menu.getBoundingClientRect()
    menu.classList.add('is-open')
    menu.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) void close(undefined, false) }
    const dismiss = () => { void close() }
    // Touch release can restore focus to the held trigger after the menu opens.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !menu.contains(event.target as Node)) {
        event.preventDefault(); event.stopImmediatePropagation(); void close()
      }
    }
    document.addEventListener('keydown', escape, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('keydown', escape, true)
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', dismiss)
    }
    // This instance is keyed by the menu target; callbacks belong to that opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function keyboard(event: KeyboardEvent) {
    const buttons = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>('button'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1 })
      buttons[next].focus()
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation(); void close()
    }
  }

  return createPortal(<div ref={ref} role="menu" aria-label={`${target.title} actions`} className="chat-context-menu t-toast" onKeyDown={keyboard} onContextMenu={e => e.preventDefault()}>
    {actions.map(({ id, label, icon: Icon, ...item }, index) => <div key={id} role="none">
      {'separator' in item && <div role="separator" className="chat-menu-separator" />}
      <button type="button" role="menuitem" tabIndex={index === 0 ? 0 : -1} className={id === 'delete' ? 'is-danger' : ''} onClick={() => void close(id)}><Icon size={17} aria-hidden="true" /><span>{label}</span></button>
    </div>)}
  </div>, document.body)
}
