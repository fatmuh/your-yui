import { useEffect, useRef, type PointerEvent, type MouseEvent } from 'react'

/** Touch/pen long press, without treating a tap or scroll as a menu request. */
export function useLongPressMenu(onOpen: (element: HTMLButtonElement, x: number, y: number) => void) {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const suppressClickUntil = useRef(0)
  const callback = useRef(onOpen)
  callback.current = onOpen

  function cancel() {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => cancel, [])

  return {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      cancel()
      suppressClickUntil.current = 0
      if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) return
      const element = event.currentTarget
      const { clientX: x, clientY: y } = event
      press.current = { x, y, timer: setTimeout(() => {
        press.current = null
        suppressClickUntil.current = Date.now() + 1500
        callback.current(element, x, y)
      }, 550) }
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture(event: MouseEvent<HTMLButtonElement>) {
      if (Date.now() < suppressClickUntil.current) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    onContextMenu(event: MouseEvent<HTMLButtonElement>) {
      event.preventDefault()
      event.stopPropagation()
      cancel()
      if (Date.now() < suppressClickUntil.current) return
      suppressClickUntil.current = Date.now() + 1500
      callback.current(event.currentTarget, event.clientX, event.clientY)
    },
  }
}
