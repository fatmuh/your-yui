type MicHandle = { stream: MediaStream; release: () => void }

let tail: Promise<void> = Promise.resolve()

/** One live microphone at a time. The next caller waits until release(). */
export function acquireMic(): Promise<MicHandle> {
  let unlock!: () => void
  const released = new Promise<void>(resolve => { unlock = resolve })
  const turn = tail.then(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      let done = false
      return {
        stream,
        release() {
          if (done) return
          done = true
          stream.getTracks().forEach(track => { track.onended = null; track.stop() })
          unlock()
        },
      }
    } catch (error) {
      unlock()
      throw error
    }
  })
  tail = turn.then(() => released, () => released)
  return turn
}
