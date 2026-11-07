import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import './select-menu.css'

type Option = string | { value: string; label: string }
type Item = { value: string; label: string }

type Props = {
  id: string
  value: string
  options: Option[]
  onChange: (value: string) => void
  variant: 'settings' | 'call' | 'panel'
  labelledBy: string
  controlRef?: RefObject<HTMLButtonElement | null>
}

function itemsOf(options: Option[]): Item[] {
  return options.map(option => typeof option === 'string' ? { value: option, label: option } : option)
}

function place(popup: HTMLElement, button: HTMLElement) {
  const margin = 8
  const gap = 6
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const trigger = button.getBoundingClientRect()
  const rtl = getComputedStyle(button).direction === 'rtl'
  const maxWidth = Math.max(120, vw - margin * 2)

  popup.style.position = 'fixed'
  popup.style.inset = 'auto'
  popup.style.margin = '0'
  popup.style.boxSizing = 'border-box'
  popup.style.maxWidth = `${maxWidth}px`
  popup.style.width = 'max-content'
  popup.style.minWidth = '0px'
  popup.style.maxHeight = 'none'

  // offsetWidth ignores the open scale, so the locked width is not 97% of the label.
  // Label scrollWidth is the full nowrap string even when a previous width squeezed the row.
  const popupStyle = getComputedStyle(popup)
  const popupChrome = parseFloat(popupStyle.paddingInlineStart) + parseFloat(popupStyle.paddingInlineEnd) + parseFloat(popupStyle.borderInlineStartWidth) + parseFloat(popupStyle.borderInlineEndWidth)
  let content = popup.offsetWidth
  for (const option of popup.querySelectorAll<HTMLElement>('.select-option')) {
    const optionStyle = getComputedStyle(option)
    const label = option.querySelector<HTMLElement>('.select-option-label')
    const check = option.querySelector<HTMLElement>('.select-check')
    const gap = parseFloat(optionStyle.columnGap || optionStyle.gap || '0')
    const row = (check?.offsetWidth ?? 0) + (label?.scrollWidth ?? 0) + parseFloat(optionStyle.paddingInlineStart) + parseFloat(optionStyle.paddingInlineEnd) + (Number.isFinite(gap) ? gap : 0)
    content = Math.max(content, Math.ceil(row + popupChrome))
  }
  const triggerWidth = Math.ceil(trigger.width)
  const width = Math.min(Math.max(content, triggerWidth), maxWidth)
  popup.style.width = `${width}px`
  popup.style.minWidth = `${Math.min(triggerWidth, maxWidth)}px`

  let left = rtl ? trigger.left : trigger.right - width
  left = Math.max(margin, Math.min(left, vw - width - margin))

  const needed = popup.scrollHeight
  const spaceBelow = vh - trigger.bottom - margin - gap
  const spaceAbove = trigger.top - margin - gap
  const openAbove = needed > spaceBelow && spaceAbove > spaceBelow
  const maxHeight = Math.max(80, openAbove ? spaceAbove : spaceBelow)
  popup.style.maxHeight = `${maxHeight}px`
  const height = Math.min(popup.scrollHeight, maxHeight)
  let top = openAbove ? trigger.top - gap - height : trigger.bottom + gap
  top = Math.max(margin, Math.min(top, vh - height - margin))

  popup.style.left = `${left}px`
  popup.style.top = `${top}px`
  popup.dataset.side = openAbove ? 'above' : 'below'
  popup.style.transformOrigin = `${openAbove ? 'bottom' : 'top'} ${rtl ? 'left' : 'right'}`
}

function reveal(option: HTMLElement, popup: HTMLElement) {
  const optionBox = option.getBoundingClientRect()
  const popupBox = popup.getBoundingClientRect()
  if (optionBox.top < popupBox.top) popup.scrollTop -= popupBox.top - optionBox.top
  else if (optionBox.bottom > popupBox.bottom) popup.scrollTop += optionBox.bottom - popupBox.bottom
}


function motionMs(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const directedMotion = new WeakMap<HTMLElement, Animation>()

function motionFrame(popup: HTMLElement): Keyframe {
  const style = getComputedStyle(popup)
  return {
    opacity: style.opacity,
    transform: style.transform,
    filter: style.filter,
  }
}

function animateDirected(popup: HTMLElement, frames: Keyframe[], duration: number, easing: string) {
  directedMotion.get(popup)?.cancel()
  const animation = popup.animate(frames, { duration, easing, fill: 'both' })
  directedMotion.set(popup, animation)
  animation.finished.then(() => {
    if (directedMotion.get(popup) !== animation) return
    directedMotion.delete(popup)
    animation.cancel()
  }, () => { /* A new direction replaced this animation. */ })
}

function motionTokens(popup: HTMLElement) {
  const style = getComputedStyle(popup)
  const distance = Number.parseFloat(style.getPropertyValue('--toast-distance'))
  const scale = Number.parseFloat(style.getPropertyValue('--toast-scale'))
  return {
    distance: Number.isFinite(distance) ? distance : 16,
    scale: Number.isFinite(scale) ? scale : 0.97,
    blur: style.getPropertyValue('--toast-blur').trim() || '2px',
    easing: style.getPropertyValue('--toast-ease').trim() || 'cubic-bezier(0.22, 1, 0.36, 1)',
    open: motionMs(style.getPropertyValue('--toast-open'), 350),
    close: motionMs(style.getPropertyValue('--toast-close'), 250),
  }
}

function sideOffset(popup: HTMLElement, distance: number) {
  return popup.dataset.side === 'above' ? distance : -distance
}

function playOpen(popup: HTMLElement) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const motion = motionTokens(popup)
  const start = directedMotion.has(popup) ? motionFrame(popup) : {
    opacity: 0,
    transform: `translateY(${sideOffset(popup, motion.distance)}px) scale(${motion.scale})`,
    filter: `blur(${motion.blur})`,
  }
  animateDirected(popup, [
    start,
    { opacity: 1, transform: 'translateY(0px) scale(1)', filter: 'blur(0px)' },
  ], motion.open, motion.easing)
}

function playClose(popup: HTMLElement) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const motion = motionTokens(popup)
  const start = motionFrame(popup)
  animateDirected(popup, [
    start,
    { opacity: 0, transform: `translateY(${sideOffset(popup, motion.distance)}px) scale(${motion.scale})`, filter: `blur(${motion.blur})` },
  ], motion.close, motion.easing)
}

function unavailable(button: HTMLElement) {
  return !button.isConnected || button.getClientRects().length === 0 || Boolean(button.closest('[inert], [hidden], [aria-hidden="true"], [data-open="false"]'))
}

export function SelectMenu({ id, value, options, onChange, variant, labelledBy, controlRef }: Props) {
  const list = itemsOf(options)
  const selected = list.find(option => option.value === value) ?? { value, label: value }
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(value)
  const [host, setHost] = useState<Element | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const restoreOnClose = useRef(false)
  const pendingActive = useRef<string | null>(null)
  const buffer = useRef('')
  const bufferTimer = useRef(0)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const listRef = useRef(list)
  valueRef.current = value
  onChangeRef.current = onChange
  listRef.current = list

  function assignButton(node: HTMLButtonElement | null) {
    buttonRef.current = node
    if (controlRef) controlRef.current = node
    if (!node) return
    // A body-level popover sits under an open modal dialog and cannot be focused.
    // Parenting it to that dialog keeps it in the top layer, above overflow and transform.
    const next = node.closest('dialog') ?? document.body
    setHost(current => current === next ? current : next)
  }

  function focusOption(next: string) {
    const popup = popupRef.current
    const option = popup?.querySelector<HTMLElement>(`[role="option"][data-value="${CSS.escape(next)}"]`)
    if (!option) return
    option.focus({ preventScroll: true })
    if (popup) reveal(option, popup)
  }

  function hide(restore: boolean) {
    const popup = popupRef.current
    restoreOnClose.current = restore
    if (popup?.matches(':popover-open')) popup.hidePopover()
    else if (restore) buttonRef.current?.focus({ preventScroll: true })
  }

  function choose(next: string) {
    onChangeRef.current(next)
    hide(true)
  }

  function move(delta: number | 'first' | 'last') {
    const optionsNow = listRef.current
    if (!optionsNow.length) return
    const index = Math.max(0, optionsNow.findIndex(option => option.value === active))
    const next = delta === 'first' ? 0 : delta === 'last' ? optionsNow.length - 1 : Math.min(optionsNow.length - 1, Math.max(0, index + delta))
    const nextValue = optionsNow[next].value
    setActive(nextValue)
    focusOption(nextValue)
  }

  function typeahead(key: string, commit: boolean) {
    if (key.length !== 1 || key === ' ') return false
    buffer.current = (buffer.current + key).toLowerCase()
    window.clearTimeout(bufferTimer.current)
    bufferTimer.current = window.setTimeout(() => { buffer.current = '' }, 500)
    const optionsNow = listRef.current
    const current = commit ? valueRef.current : active
    const start = Math.max(0, optionsNow.findIndex(option => option.value === current))
    const ordered = [...optionsNow.slice(start + 1), ...optionsNow.slice(0, start + 1)]
    const match = ordered.find(option => option.label.toLowerCase().startsWith(buffer.current))
    if (match) {
      if (commit) onChangeRef.current(match.value)
      else {
        setActive(match.value)
        focusOption(match.value)
      }
    }
    return true
  }

  useEffect(() => {
    const popup = popupRef.current
    if (!popup) return
    function onBeforeToggle(event: Event) {
      if (!(event instanceof ToggleEvent)) return
      const button = buttonRef.current
      if (event.newState === 'open') {
        if (!button) return
        // A closed popover has no layout. Measure before showing it so the
        // first painted frame already has the correct placement and direction.
        popup!.style.display = 'block'
        popup!.style.visibility = 'hidden'
        place(popup!, button)
        playOpen(popup!)
        popup!.style.display = ''
        popup!.style.visibility = ''
        return
      }
      // Direction is known here. Start it before hidePopover drops :popover-open.
      playClose(popup!)
      popup!.inert = true
      popup!.classList.remove('is-open')
      setOpen(false)
      if (restoreOnClose.current) {
        restoreOnClose.current = false
        button?.focus({ preventScroll: true })
      }
    }
    function onToggle(event: Event) {
      if (!(event instanceof ToggleEvent)) return
      const button = buttonRef.current
      if (event.newState === 'open') {
        popup!.inert = false
        if (button) place(popup!, button)
        const next = pendingActive.current ?? valueRef.current
        pendingActive.current = null
        setActive(next)
        setOpen(true)
        focusOption(next)
        return
      }
      setOpen(false)
      popup!.classList.remove('is-open')
      if (restoreOnClose.current) {
        restoreOnClose.current = false
        button?.focus({ preventScroll: true })
      }
    }
    // Capture so a document Escape handler cannot also close the panel or call.
    // Do not hide here: the popover close watcher must consume Escape before the dialog.
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !popup!.matches(':popover-open')) return
      event.stopImmediatePropagation()
      restoreOnClose.current = true
    }
    function onTab(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !popup!.matches(':popover-open')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      restoreOnClose.current = true
      popup!.hidePopover()
    }
    popup.addEventListener('beforetoggle', onBeforeToggle)
    popup.addEventListener('toggle', onToggle)
    popup.addEventListener('keydown', onEscape, true)
    popup.addEventListener('keydown', onTab, true)
    return () => {
      popup.removeEventListener('beforetoggle', onBeforeToggle)
      popup.removeEventListener('toggle', onToggle)
      popup.removeEventListener('keydown', onEscape, true)
      popup.removeEventListener('keydown', onTab, true)
      window.clearTimeout(bufferTimer.current)
      if (popup.matches(':popover-open')) popup.hidePopover()
    }
  }, [host])

  useLayoutEffect(() => {
    if (!open) return
    const popup = popupRef.current
    const button = buttonRef.current
    if (!popup || !button) return
    place(popup, button)
    const frame = requestAnimationFrame(() => {
      if (popup.matches(':popover-open')) popup.classList.add('is-open')
    })
    const closeIfGone = () => {
      if (!unavailable(button) || !popup.matches(':popover-open')) return
      restoreOnClose.current = false
      popup.hidePopover()
    }
    const observer = new MutationObserver(closeIfGone)
    let node: Node | null = button
    while (node) {
      if (node instanceof Element) observer.observe(node, { attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden', 'data-open'] })
      node = node.parentNode
    }
    const onScroll = (event: Event) => {
      if (popup.contains(event.target as Node)) return
      if (!button.isConnected) return
      place(popup, button)
      closeIfGone()
    }
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const popup = popupRef.current
    const button = buttonRef.current
    if (!popup) return
    const option = popup.querySelector<HTMLElement>(`[role="option"][data-value="${CSS.escape(active)}"]`)
    if (!option || document.activeElement === option) return
    const focusInside = popup.contains(document.activeElement) || document.activeElement === button
    if (!focusInside) return
    option.focus({ preventScroll: true })
    reveal(option, popup)
  }, [open, active])

  function onButtonKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    const popup = popupRef.current
    const isOpen = popup?.matches(':popover-open') ?? false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!list.length) return
      if (!isOpen) {
        pendingActive.current = event.key === 'ArrowUp' ? list[list.length - 1].value : value
        popup?.showPopover()
      } else move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (!list.length) return
      if (isOpen) move(event.key === 'Home' ? 'first' : 'last')
      else onChange(event.key === 'Home' ? list[0].value : list[list.length - 1].value)
      return
    }
    if (!isOpen && typeahead(event.key, true)) event.preventDefault()
  }

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      move(event.key === 'Home' ? 'first' : 'last')
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const focused = document.activeElement
      const focusedValue = focused instanceof HTMLElement && popupRef.current?.contains(focused) ? focused.getAttribute('data-value') : null
      choose(focusedValue || active)
    } else if (typeahead(event.key, false)) event.preventDefault()
  }

  const listId = `${id}-listbox`
  const valueId = `${id}-value`
  return <>
    <button
      ref={assignButton}
      type="button"
      id={id}
      className={`select-trigger select-trigger--${variant}`}
      data-value={value}
      popoverTarget={listId}
      popoverTargetAction="toggle"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      aria-labelledby={`${labelledBy} ${valueId}`}
      onKeyDown={onButtonKeyDown}
    >
      <span id={valueId} className="select-value">{selected.label}</span>
      <ChevronDown className="select-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
    </button>
    {host && createPortal(<div
      ref={popupRef}
      id={listId}
      className={`select-popup t-toast select-popup--${variant}`}
      popover="auto"
      role="listbox"
      aria-labelledby={labelledBy}
      onKeyDown={onListKeyDown}
      onContextMenu={event => event.preventDefault()}
    >
      {list.map(option => {
        const isSelected = option.value === value
        return <div
          key={option.value}
          role="option"
          data-value={option.value}
          aria-selected={isSelected}
          tabIndex={option.value === active ? 0 : -1}
          className="select-option"
          onMouseDown={event => event.preventDefault()}
          onClick={() => choose(option.value)}
        >
          <span className="select-option-label">{option.label}</span>
          <span className="select-check" aria-hidden="true">{isSelected ? <Check size={12} strokeWidth={2.4} /> : null}</span>
        </div>
      })}
    </div>, host)}
  </>
}
