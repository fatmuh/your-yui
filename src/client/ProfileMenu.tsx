import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, History, LogOut, Settings, Smartphone, SquareArrowOutUpRight, UserPlus } from 'lucide-react'

export type ProfileAction = 'trial' | 'mobile' | 'support' | 'settings' | 'account' | 'logout'

const items = [
  { id: 'trial', label: 'Trial usage', icon: History, meta: '8% used', chevron: true },
  { id: 'mobile', label: 'Get Yui for mobile', icon: Smartphone },
  { id: 'support', label: 'Support', icon: SquareArrowOutUpRight, chevron: true },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'account', label: 'Add account', icon: UserPlus, separator: true },
  { id: 'logout', label: 'Log out', icon: LogOut },
] as const

export function ProfileMenu({ trigger, keyboard = false, onClose, onSelect }: { trigger: HTMLElement; keyboard?: boolean; onClose: () => void; onSelect: (action: ProfileAction) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const closing = useRef(false)

  async function close(action?: ProfileAction, restore = true) {
    const menu = ref.current
    if (!menu || closing.current) return
    closing.current = true
    menu.classList.remove('is-open')
    menu.inert = true
    await Promise.allSettled(menu.getAnimations().map(animation => animation.finished))
    if (!menu.isConnected) return
    if (restore && trigger.isConnected) trigger.focus({ preventScroll: true })
    onClose()
    if (action) onSelect(action)
  }

  useLayoutEffect(() => {
    const menu = ref.current!
    const place = () => {
      const box = trigger.getBoundingClientRect()
      const margin = 8
      const gap = 8
      const rtl = getComputedStyle(menu).direction === 'rtl'
      const width = menu.offsetWidth
      const roomAbove = Math.max(120, box.top - margin - gap)
      menu.style.maxHeight = `${roomAbove}px`
      const height = menu.offsetHeight
      let left = rtl ? box.right - width : box.left
      left = Math.max(margin, Math.min(left, innerWidth - width - margin))
      let top = box.top - gap - height
      if (top < margin) top = Math.min(box.bottom + gap, innerHeight - height - margin)
      menu.style.left = `${left}px`
      menu.style.top = `${top}px`
      menu.style.transformOrigin = rtl ? 'bottom right' : 'bottom left'
    }
    place()
    void menu.getBoundingClientRect()
    if (keyboard) menu.dataset.kbd = 'true'
    menu.classList.add('is-open')
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (menu.contains(target)) return
      void close(undefined, trigger.contains(target))
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      void close()
    }
    const dismiss = () => { void close() }
    const scrolled = (event: Event) => { if (!menu.contains(event.target as Node)) void close() }
    document.addEventListener('keydown', escape, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', scrolled, true)
    return () => {
      document.removeEventListener('keydown', escape, true)
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', scrolled, true)
    }
    // This instance belongs to one opening. Callbacks are stable for that opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onMenuKeyDown(event: KeyboardEvent) {
    const buttons = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>('button'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      ref.current!.dataset.kbd = 'true'
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1 })
      buttons[next].focus({ preventScroll: true })
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      void close()
    }
  }

  return createPortal(<div ref={ref} id="workspace-menu" role="menu" aria-label="Workspace menu" className="profile-menu t-toast" onKeyDown={onMenuKeyDown} onContextMenu={event => event.preventDefault()}>
    {items.map(({ id, label, icon: Icon, ...item }, index) => <div key={id} role="none">
      {'separator' in item && <div role="separator" className="profile-menu-separator" />}
      <button type="button" role="menuitem" data-action={id} tabIndex={index === 0 ? 0 : -1} onClick={() => void close(id)}>
        <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
        <span className="profile-menu-label">{label}</span>
        {'meta' in item && <span className="sr-only">, </span>}
        {('meta' in item || 'chevron' in item) && <span className="profile-menu-trail">
          {'meta' in item && <span className="profile-menu-meta">{item.meta}</span>}
          {'chevron' in item && <ChevronRight className="profile-menu-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />}
        </span>}
      </button>
    </div>)}
  </div>, document.body)
}
