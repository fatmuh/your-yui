import { useEffect, useRef } from 'react'

/** Keep native dialog modality/focus restoration until the exit transition finishes. */
export function useAnimatedDialog(open: boolean, onClosed: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const generation = useRef(0)
  const closing = useRef(false)
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed

  async function close(afterClose?: () => void) {
    const dialog = dialogRef.current
    if (!dialog?.open || closing.current) return
    closing.current = true
    const current = ++generation.current
    dialog.classList.remove('is-open')
    dialog.classList.add('is-closing')
    // getAnimations flushes styles and uses the actual CSS token durations.
    // Reduced motion produces no transitions, so cleanup happens immediately.
    await Promise.allSettled(dialog.getAnimations().map(animation => animation.finished))
    if (current !== generation.current || !dialog.isConnected) return
    dialog.close()
    dialog.classList.remove('is-closing')
    closing.current = false
    onClosedRef.current()
    afterClose?.()
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      ++generation.current
      closing.current = false
      dialog.classList.remove('is-closing')
      if (!dialog.open) {
        dialog.classList.remove('is-open')
        dialog.showModal()
        // Establish the snippet's 0.96/transparent start state before opening.
        void dialog.getBoundingClientRect()
      }
      dialog.classList.add('is-open')
    } else {
      void close()
    }
    // Callbacks are read through a ref; only the controlled open state drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => () => { ++generation.current }, [])
  return { dialogRef, close }
}
