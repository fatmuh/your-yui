import React, { useEffect, useRef, useState } from 'react'
import { ArrowUp, AudioLines, FileText, Menu, Mic, MicOff, MoreHorizontal, Paperclip, Pin, Plus, Search, Star, X } from 'lucide-react'
import { ulid } from 'ulidx'
import { AgentPanel } from './AgentPanel'
import { CommandPalette } from './CommandPalette'
import { ConnectAppsDialog } from './ConnectAppsDialog'
import { CreateBotDialog } from './CreateBotDialog'
import { SettingsDialog } from './SettingsDialog'
import { BotAvatar as Avatar, type BotAppearance } from './BotAvatar'
import { ChatContextMenu, type ChatAction, type ChatMenuTarget } from './ChatContextMenu'
import { ProfileMenu, type ProfileAction } from './ProfileMenu'
import { ChatActionDialog } from './ChatActionDialog'
import { PinnedBotButton } from './PinnedBotButton'
import { useVoiceRecorder, voiceTime, type VoiceNote } from './useVoiceRecorder'
import { VoiceNoteControls } from './VoiceNoteControls'
import { VoiceCall } from './VoiceCall'
import { useSession } from './SessionContext.tsx'
import { ApiError, fetchThreadMessages, listThreads, resolveActiveKind, streamTurn, uploadAudioNote } from './api.ts'
import type { MessageDto } from '../shared/app.ts'
import type { YuiEvent } from '../shared/engine.ts'
import './styles.css'

// crypto.randomUUID hanya tersedia di secure context (https/localhost) — di
// LAN http://<ip> ia undefined, jadi jatuh ke ulid agar id tetap tergenerasi.
const newId = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : ulid())

type Message = { id: string; role: 'assistant' | 'user'; text: string; files?: string[]; audio?: { url: string; duration: number }; kind?: 'choices' }
// `server` marks a conversation backed by a server thread (its id IS the
// thread id); `loaded` marks a server conversation whose history is already
// in state (lazy-loaded once, never refetched during the session).
type Conversation = { id: string; title: string; bot?: 'yui'; appearance?: BotAppearance; messages: Message[]; pinned?: boolean; unread?: boolean; hidden?: boolean; section?: string; server?: boolean; loaded?: boolean }
// Per-turn stream context: the conversation the turn was sent from, plus the
// server thread id once the first thread.updated event reveals it.
type TurnState = { chatId: string; threadId?: string }
type Modal = 'apps' | 'create-bot' | 'settings' | null

const greeting = "Hi Fathur, I'm CFO. I'm here to help you keep your money in good shape, whether that's for a business, your personal finances, or both."
const openingQuestion = 'What would you like me to help with first?'
const openingChoices = [
  { key: 'A', label: 'Business finances' },
  { key: 'B', label: 'Personal finances' },
  { key: 'C', label: 'Both' },
  { key: 'D', label: 'Something else' },
] as const
// Client-side mirror of the server's 5 MB audio cap: a UX guard that skips
// the request with a clear message, not a security boundary — the server
// rejects oversized blobs on its own (src/server/audio/routes.ts).
const VOICE_NOTE_MAX_BYTES = 5 * 1024 * 1024
const makeConversation = (): Conversation => ({
  id: newId(),
  title: 'CFO',
  messages: [
    { id: newId(), role: 'assistant', text: greeting },
    { id: newId(), role: 'assistant', kind: 'choices', text: openingQuestion },
  ],
})

/**
 * Map one thread's server history (MessageDto[]) to client Message[] for
 * loadHistory. Two invariants keep reloaded voice notes playable:
 * (a) client `audio.duration` is in SECONDS (voiceTime and the aria-label
 *     consume seconds) — the mirror of the single seconds→milliseconds
 *     conversion at upload time in sendServerVoiceNote;
 * (b) `id` passes through UNCHANGED from the DTO — the render keys messages
 *     by this id, so the stable server id keeps the native <audio> element
 *     from remounting across re-renders (playback keeps running while the
 *     thread scrolls).
 */
export function historyToClientMessages(messages: MessageDto[]): Message[] {
  return messages.map(message => {
    const client: Message = { id: message.id, role: message.role, text: message.text }
    if (message.audio) {
      // Relative URL: same-origin as the app, so the session cookie rides the
      // media request and the owner-scoped GET needs no token in the URL.
      client.audio = { url: `/api/audio/${encodeURIComponent(message.audio.id)}`, duration: message.audio.durationMs / 1000 }
    }
    return client
  })
}

function AppIcon({ app }: { app: 'drive' | 'calendar' | 'notion' }) {
  if (app === 'drive') return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0DA960" d="m9 3-7 12 4 7 7-12z" /><path fill="#FDCB42" d="m9 3 8 0 7 12-8 0z" /><path fill="#4385F5" d="m2 15 14 0 8 0-4 7H6z" /></svg>
  if (app === 'calendar') return <span aria-hidden="true" className="calendar-icon"><span />31</span>
  return <span aria-hidden="true" className="notion-icon">N</span>
}

export default function App() {
  const { signOut } = useSession()
  const [conversations, setConversations] = useState<Conversation[]>(() => [makeConversation(), {
    id: newId(), title: 'Yui', bot: 'yui', pinned: true,
    messages: [{ id: newId(), role: 'assistant', text: "Hi Fathur, I'm Yui. What would you like to work on today?" }],
  }])
  // Pinned to the first local conversation up front: the mount fetch below
  // prepends server threads to the array, which must never silently switch
  // which conversation the fallback `active` resolves to.
  const [activeId, setActiveId] = useState<string | null>(() => conversations[0].id)
  const active = conversations.find(chat => chat.id === activeId) ?? conversations[0]
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [typingId, setTypingId] = useState<string | null>(null)
  // Assistant bubble currently growing from message.delta events of a server
  // turn — keyed by the event's messageId so cumulative text replaces in place.
  const streamingMessageRef = useRef<{ chatId: string; messageId: string } | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [callMuted, setCallMuted] = useState(false)
  const callTriggerRef = useRef<HTMLButtonElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelInitialTab, setPanelInitialTab] = useState<'Details' | 'Computer'>('Details')
  const [panelOverlay, setPanelOverlay] = useState(() => matchMedia('(max-width: 1199px)').matches)
  const agentTriggerRef = useRef<HTMLButtonElement>(null)
  const [isMobile, setIsMobile] = useState(() => matchMedia('(max-width: 767px)').matches)
  const sidebarRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [chatMenu, setChatMenu] = useState<ChatMenuTarget | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [profileKeyboard, setProfileKeyboard] = useState(false)
  const profileButtonRef = useRef<HTMLButtonElement>(null)
  const [spellCheck, setSpellCheck] = useState(true)
  const [chatAction, setChatAction] = useState<{ id: string; title: string; action: 'rename' | 'section' | 'delete' } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const audioUrls = useRef(new Set<string>())
  const voice = useVoiceRecorder(active.id, sendVoiceNote)
  const voiceActive = voice.phase !== 'idle'
  const voiceStatus = voice.phase === 'recording' ? 'Recording voice note. Stop to send, or cancel.' : voice.phase === 'requesting' ? 'Waiting for microphone permission. Allow access in your browser, or cancel.' : voice.phase === 'stopping' ? 'Preparing voice note.' : ''

  useEffect(() => () => audioUrls.current.forEach(url => URL.revokeObjectURL(url)), [])

  // Mount: map server threads (GET /api/threads, updatedAt desc) to server
  // conversations ahead of the local demo ones. The pinned Yui contact keeps
  // its local id until its first turn migrates it to the real thread id.
  // Failures keep the local list untouched — a notice is all the user gets.
  useEffect(() => {
    let cancelled = false
    listThreads()
      .then(threads => {
        if (cancelled || threads.length === 0) return
        setConversations(current => {
          const known = new Set(current.map(chat => chat.id))
          const mapped = threads.filter(thread => !known.has(thread.id)).map<Conversation>(thread => ({
            id: thread.id, title: thread.title, bot: 'yui', server: true, messages: [],
          }))
          return mapped.length === 0 ? current : [...mapped, ...current]
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setNotice(error instanceof ApiError && error.code === 'unauthorized'
          ? 'Session expired. Sign in again.'
          : 'Could not load your Yui conversations. The demo chats stay available.')
      })
    return () => { cancelled = true }
  }, [])
  function sendVoiceNote(note: VoiceNote, chatId: string) {
    // Same predicate sendMessage uses on `active`, evaluated against the
    // conversation the recording started in: only the Yui contact uploads and
    // streams a turn; every other conversation keeps the local path below.
    const target = conversations.find(chat => chat.id === chatId)
    if (target?.server || target?.bot === 'yui') {
      sendServerVoiceNote(note, chatId, target.server === true)
      return
    }
    const url = URL.createObjectURL(note.blob)
    audioUrls.current.add(url)
    const message: Message = { id: newId(), role: 'user', text: `Voice note · ${voiceTime(note.duration)}`, audio: { url, duration: note.duration } }
    setConversations(current => current.map(chat => chat.id === chatId ? { ...chat, messages: [...chat.messages, message] } : chat))
    setNotice('Voice note added to this local chat. No audio was uploaded or transcribed.')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // Server voice turn for the Yui contact: size guard → optimistic voice
  // bubble → upload → turn {audioId} → streamed events, mirroring
  // sendServerMessage. Every failure stage releases the composer and leaves no
  // orphaned bubble or object URL behind.
  function sendServerVoiceNote(note: VoiceNote, chatId: string, serverChat: boolean) {
    if (note.blob.size > VOICE_NOTE_MAX_BYTES) {
      // Nothing was created yet: refuse before any request or bubble.
      setNotice('This recording is too large to send. Record a shorter one and try again.')
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    const url = URL.createObjectURL(note.blob)
    audioUrls.current.add(url)
    const message: Message = { id: newId(), role: 'user', text: `Voice note · ${voiceTime(note.duration)}`, audio: { url, duration: note.duration } }
    setConversations(current => current.map(chat => chat.id === chatId ? { ...chat, messages: [...chat.messages, message] } : chat))
    setTypingId(chatId)
    void uploadAudioNote(note.blob, Math.round(note.duration * 1000))
      .catch((error: unknown) => {
        // The upload never landed: remove the optimistic bubble and revoke its
        // object URL (the recording is dropped — v1 has no retry), then surface
        // why. The typingId release is turn-scoped like everywhere else: a
        // text turn may still be streaming in this chat (the recorder is not
        // gated on typingId), and clearing it wholesale would unblock the
        // composer under that stream.
        setConversations(current => current.map(chat => chat.id === chatId ? { ...chat, messages: chat.messages.filter(item => item.id !== message.id) } : chat))
        URL.revokeObjectURL(url)
        audioUrls.current.delete(url)
        setTypingId(current => current === chatId ? null : current)
        setNotice(error instanceof ApiError ? error.message : 'Could not upload the voice note. Try again.')
        requestAnimationFrame(() => inputRef.current?.focus())
        return null
      })
      .then(uploaded => {
        if (uploaded === null) return
        const turn: TurnState = { chatId, threadId: serverChat ? chatId : undefined }
        // Same per-send kind resolution as a text turn (two parallel GETs): a
        // failure never blocks the turn — it goes out without `kind`.
        void resolveActiveKind()
          .catch(() => null)
          .then(kind => streamTurn({ audioId: uploaded.id, threadId: turn.threadId, clientToken: newId(), kind: kind ?? undefined }, event => applyTurnEvent(turn, event)))
          .catch((error: unknown) => {
            // Pre-stream rejection or mid-stream failure: identical handling to
            // sendServerMessage. The optimistic voice bubble stays (v1 has no
            // auto-retry) and still plays — its object URL is backed by the
            // local blob, not the server.
            streamingMessageRef.current = null
            setTypingId(current => current === (turn.threadId ?? turn.chatId) ? null : current)
            if (error instanceof ApiError && error.code === 'unauthorized') setNotice('Session expired. Sign in again.')
            else if (error instanceof ApiError) setNotice(error.message)
            else setNotice('Could not reach Yui. Check your connection and try again.')
          })
      })
  }
  function cancelVoice() {
    voice.cancel()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  useEffect(() => {
    function commandShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.isComposing) {
        event.preventDefault()
        if (document.querySelector('dialog[open]:not(.command-palette), [role="listbox"]:popover-open')) return
        setPaletteOpen(open => !open)
      }
    }
    document.addEventListener('keydown', commandShortcut)
    return () => document.removeEventListener('keydown', commandShortcut)
  }, [])
  useEffect(() => {
    const media = matchMedia('(max-width: 1199px)')
    const update = () => setPanelOverlay(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const media = matchMedia('(max-width: 767px)')
    const update = () => { setIsMobile(media.matches); setSidebarOpen(false) }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!sidebarOpen || !isMobile) return
    const trigger = menuRef.current
    sidebarRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    function trapFocus(event: KeyboardEvent) {
      if (document.querySelector('dialog[open], [role="menu"], [role="listbox"]:popover-open')) return
      if (event.key === 'Escape') { event.preventDefault(); setSidebarOpen(false) }
      if (event.key !== 'Tab') return
      const buttons = sidebarRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      if (!buttons?.length) return
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', trapFocus)
    return () => { document.removeEventListener('keydown', trapFocus); trigger?.focus() }
  }, [sidebarOpen, isMobile])
  useEffect(() => {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    endRef.current?.scrollIntoView({ behavior, block: 'end' })
  }, [active.id, active.messages.length, typingId])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4200)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if ((isMobile && !sidebarOpen) || modal || paletteOpen) setProfileOpen(false)
  }, [isMobile, sidebarOpen, modal, paletteOpen])
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`
    }
  }, [draft])

  function endCall() {
    setCallId(null)
    setCallMuted(false)
    requestAnimationFrame(() => {
      const next = callTriggerRef.current ?? inputRef.current
      next?.focus({ preventScroll: true })
    })
  }
  useEffect(() => { setCallId(null); setCallMuted(false) }, [active.id])

  function newChat() {
    setPanelOpen(false)
    setModal('create-bot')
  }

  function botAccent(chat: { appearance?: BotAppearance; bot?: 'yui' }) {
    return chat.appearance?.color ?? (chat.bot === 'yui' ? '#ffffff' : '#11c478')
  }

  function createBot(title: string, appearance: BotAppearance) {
    const chat: Conversation = {
      id: newId(), title, appearance,
      messages: [{ id: newId(), role: 'assistant', text: `Hi Fathur, I'm ${title}. What would you like to work on today? This is a local chat demo, not an AI-powered bot.` }],
    }
    setConversations(current => [...current, chat])
    setActiveId(chat.id)
    setDraft('')
    setFiles([])
    setSidebarOpen(false)
    inputRef.current?.focus()
  }

  // Lazy-load a server conversation's history exactly once; it is cached in
  // state for the rest of the session (switching back and forth never refetches).
  function loadHistory(chatId: string) {
    fetchThreadMessages(chatId)
      .then(messages => {
        setConversations(current => current.map(chat => chat.id === chatId ? {
          ...chat,
          loaded: true,
          messages: historyToClientMessages(messages),
        } : chat))
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'not_found') {
          // Thread gone server-side: keep it empty and stop retrying.
          setConversations(current => current.map(chat => chat.id === chatId ? { ...chat, messages: [], loaded: true } : chat))
          setNotice('This conversation is no longer available on the server.')
          return
        }
        setNotice(error instanceof ApiError && error.code === 'unauthorized'
          ? 'Session expired. Sign in again.'
          : 'Could not load the conversation history. Select it again to retry.')
      })
  }

  function selectChat(id: string) {
    const target = conversations.find(chat => chat.id === id)
    if (target?.server && target.loaded !== true) loadHistory(id)
    setConversations(current => current.map(chat => chat.id === id ? { ...chat, unread: false, hidden: false } : chat))
    setActiveId(id)
    setDraft('')
    setFiles([])
    setSidebarOpen(false)
    setModal(null)
  }

  function openChatMenu(chat: Conversation, trigger: HTMLElement, x: number, y: number) {
    setProfileOpen(false)
    setChatMenu({ id: chat.id, title: chat.title, pinned: chat.pinned, unread: chat.unread, x, y, trigger })
  }
  function selectProfile(action: ProfileAction) {
    if (action === 'settings') {
      setNotice('')
      setModal('settings')
      return
    }
    if (action === 'logout') {
      void signOut().catch(() => setNotice('Log out failed. Check your connection and try again.'))
      return
    }
    const notes: Record<Exclude<ProfileAction, 'settings' | 'logout'>, string> = {
      trial: 'Trial usage is not connected. 8% used is sample data, and this chat stays local.',
      mobile: 'The mobile app download is not connected. Stay in this browser.',
      support: 'Support is not connected. This template has no support inbox.',
      account: 'Adding an account is not connected. This demo keeps one local workspace.',
    }
    setNotice(notes[action])
  }

  function runChatAction(target: ChatMenuTarget, action: ChatAction) {
    if (action === 'rename' || action === 'section' || action === 'delete') {
      setChatAction({ id: target.id, title: target.title, action })
    } else if (action === 'copy') {
      void navigator.clipboard.writeText(target.id).then(() => setNotice('Conversation ID copied.'), () => setNotice('Unable to copy. Clipboard access is blocked by your browser.'))
    } else {
      setConversations(current => current.map(chat => chat.id !== target.id ? chat : action === 'pin' ? { ...chat, pinned: !chat.pinned } : action === 'unread' ? { ...chat, unread: !chat.unread } : { ...chat, hidden: true }))
      if (action === 'pin') requestAnimationFrame(() => {
        sidebarRef.current?.querySelector<HTMLButtonElement>(`[data-chat-id="${target.id}"]`)?.focus()
      })
      if (action === 'hide') {
        setNotice('Hidden from sidebar. Find this conversation in Search to show it again.')
        sidebarRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Search conversations"]')?.focus()
      }
    }
  }

  function confirmChatAction(value: string) {
    if (!chatAction) return
    const target = chatAction
    if (target.action === 'delete') {
      conversations.find(chat => chat.id === target.id)?.messages.forEach(message => {
        if (message.audio) { URL.revokeObjectURL(message.audio.url); audioUrls.current.delete(message.audio.url) }
      })
      const remaining = conversations.filter(chat => chat.id !== target.id)
      const next = remaining.length ? remaining : [makeConversation()]
      setConversations(next)
      if (active.id === target.id) {
        setActiveId(next[0].id); setDraft(''); setFiles([])
        if (typingId === target.id) setTypingId(null)
        // The delete fallback can land on a server thread that was never
        // selected — make sure its history still lazy-loads once.
        if (next[0].server && next[0].loaded !== true) loadHistory(next[0].id)
      }
      setNotice('Conversation deleted.')
      sidebarRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Search conversations"]')?.focus()
    } else {
      setConversations(current => current.map(chat => chat.id !== target.id ? chat : target.action === 'rename' ? { ...chat, title: value } : { ...chat, section: value }))
    }
  }

  function chooseOpening(label: string) {
    if (typingId || voiceActive) return
    if (label === 'Something else') {
      inputRef.current?.focus()
      return
    }
    if (draft.trim() || files.length) {
      setNotice('You have an unsent message. Send or clear it before choosing an answer.')
      inputRef.current?.focus()
      return
    }
    sendMessage(label)
    inputRef.current?.focus()
  }

  // Apply one streamed server event to conversation state. Every update goes
  // through functional setConversations, so events arriving after the user
  // deleted the conversation simply find no match and are ignored silently.
  function applyTurnEvent(turn: TurnState, event: YuiEvent): void {
    if (event.type === 'thread.updated') {
      if (turn.threadId === undefined) {
        // First event of a new-thread turn: migrate the local conversation id
        // to the server thread id (+ derived title) — the conversation becomes
        // server-backed from here on. Its local transcript already IS the
        // thread's full history, so it counts as loaded (no lazy fetch).
        turn.threadId = event.threadId
        const localId = turn.chatId
        const threadId = event.threadId
        setConversations(current => {
          const index = current.findIndex(chat => chat.id === localId)
          if (index === -1) return current
          const migrated: Conversation = { ...current[index], id: threadId, title: event.title ?? current[index].title, server: true, loaded: true }
          // A delayed listThreads response can already have prepended an empty
          // server stub under the new thread id — drop it too, or the id would
          // exist twice (duplicate keys; every event upsert would hit both rows).
          // The migrated conversation keeps the real local transcript.
          return [migrated, ...current.filter(chat => chat.id !== localId && chat.id !== threadId)]
        })
        setActiveId(current => current === localId ? threadId : current)
        setTypingId(current => current === localId ? threadId : current)
        return
      }
      // Existing thread: keep the freshest conversation at the top of the list.
      setConversations(current => {
        const index = current.findIndex(chat => chat.id === event.threadId)
        if (index === -1) return current
        return [current[index], ...current.filter((_, i) => i !== index)]
      })
      return
    }
    if (event.type === 'message.delta' || event.type === 'message.final') {
      // Upsert the in-progress assistant bubble keyed by the event's
      // messageId; the text is CUMULATIVE, so it replaces instead of appending.
      streamingMessageRef.current = { chatId: event.threadId, messageId: event.messageId }
      setConversations(current => current.map(chat => {
        if (chat.id !== event.threadId) return chat
        const at = chat.messages.findIndex(message => message.id === event.messageId)
        return {
          ...chat,
          messages: at === -1
            ? [...chat.messages, { id: event.messageId, role: 'assistant' as const, text: event.text }]
            : chat.messages.map((message, index) => index === at ? { ...message, text: event.text } : message),
        }
      }))
      return
    }
    if (event.type === 'error') {
      // Show the failure in-thread: replace the in-progress bubble (if any)
      // with the error text, or append one when nothing had streamed yet.
      const text = `[error] ${event.message}`
      const inProgress = streamingMessageRef.current
      streamingMessageRef.current = null
      setConversations(current => current.map(chat => {
        if (chat.id !== event.threadId) return chat
        if (inProgress !== null && inProgress.chatId === event.threadId) {
          return { ...chat, messages: chat.messages.map(message => message.id === inProgress.messageId ? { ...message, text } : message) }
        }
        return { ...chat, messages: [...chat.messages, { id: newId(), role: 'assistant' as const, text }] }
      }))
      return
    }
    // turn.settled is always the last event: release the composer — but only
    // when typingId still points at THIS turn's conversation, so a stale turn
    // cannot unblock the composer while a newer one is still streaming.
    streamingMessageRef.current = null
    setTypingId(current => current === (turn.threadId ?? turn.chatId) ? null : current)
  }

  // Server turn for the Yui contact: optimistic user bubble → POST
  // /api/engine/turn → streamed events grow the assistant bubble in place.
  function sendServerMessage(text: string) {
    if (!text) {
      // The server demands non-empty content; attachments alone stay local.
      setNotice('Type a message to send')
      return
    }
    const chatId = active.id
    const turn: TurnState = { chatId, threadId: active.server === true ? chatId : undefined }
    const message: Message = { id: newId(), role: 'user', text, files: files.map(file => file.name) }
    setConversations(current => current.map(chat => chat.id === chatId ? { ...chat, messages: [...chat.messages, message] } : chat))
    setDraft('')
    setFiles([])
    setTypingId(chatId)
    // The active kind resolves per-send (two parallel GETs), so a config saved
    // moments ago in Settings applies to this turn without a reload. Resolution
    // failure never blocks the turn: it goes out without `kind` and the server's
    // own response tells the story.
    void resolveActiveKind()
      .catch(() => null)
      .then(kind => streamTurn({ content: text, threadId: turn.threadId, clientToken: newId(), kind: kind ?? undefined }, event => applyTurnEvent(turn, event)))
      .catch((error: unknown) => {
        // Pre-stream rejection or mid-stream failure: release the composer and
        // surface a notice — turn-scoped, so a stale turn's rejection cannot
        // release a newer turn still streaming. The optimistic user bubble
        // stays (v1 has no auto-retry); an in-progress bubble keeps its last text.
        streamingMessageRef.current = null
        setTypingId(current => current === (turn.threadId ?? turn.chatId) ? null : current)
        if (error instanceof ApiError && error.code === 'unauthorized') setNotice('Session expired. Sign in again.')
        else if (error instanceof ApiError) setNotice(error.message)
        else setNotice('Could not reach Yui. Check your connection and try again.')
      })
  }

  function sendMessage(answer?: string) {
    const text = answer ?? draft.trim()
    if ((!text && files.length === 0) || typingId || voiceActive) return
    // Only the Yui contact talks to the server; every other conversation
    // keeps the template's local mock reply below, untouched.
    if (active.server || active.bot === 'yui') {
      sendServerMessage(text)
      return
    }
    const chatId = active.id
    const message: Message = { id: newId(), role: 'user', text, files: files.map(file => file.name) }
    setConversations(current => current.map(chat => chat.id === chatId ? { ...chat, messages: [...chat.messages, message] } : chat))
    setDraft('')
    setFiles([])
    setTypingId(chatId)
    timers.current.push(setTimeout(() => {
      const reply: Message = {
        id: newId(), role: 'assistant',
        text: "This is a preview of your chat template. Your message is displayed locally, but I'm not connected to an AI service yet. You can connect your own backend when you're ready.",
      }
      setConversations(current => current.map(chat => chat.id === chatId ? { ...chat, messages: [...chat.messages, reply] } : chat))
      setTypingId(null)
    }, 1200))
  }

  return <div className="app-shell flex h-dvh overflow-hidden bg-[#111111] text-[#ededed]">
    <a href="#chat-content" className="skip-link">Skip to chat</a>
    {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}

    <aside ref={sidebarRef} id="chat-sidebar" inert={(isMobile && !sidebarOpen) || (panelOverlay && panelOpen)} role={isMobile && sidebarOpen ? 'dialog' : undefined} aria-modal={isMobile && sidebarOpen ? true : undefined} className={`sidebar fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col border-r border-white/[0.045] bg-[#0d0d0d] md:static md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`} aria-label="Chat sidebar">
      <div className="sidebar-tools flex items-center justify-end gap-3">
        {isMobile && <button className="icon-button me-auto" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}><X /></button>}
        <button className="icon-button" aria-label="Search conversations" title="Search commands and conversations (Ctrl/⌘ K)" onClick={() => setPaletteOpen(true)}><Search strokeWidth={1.7} /></button>
        <button className="icon-button" aria-label="Create new bot" title="Create new bot" onClick={newChat}><Plus strokeWidth={1.7} /></button>
      </div>

      <nav className="profile bot-shortcuts" aria-label="Favorite bots">
        {conversations.filter(chat => !chat.hidden && chat.pinned).sort((a, b) => Number(b.bot === 'yui') - Number(a.bot === 'yui')).map(chat => <div key={chat.id} className="bot-shortcut-wrap">
          <PinnedBotButton id={chat.id} title={chat.title} active={active.id === chat.id} onSelect={() => { selectChat(chat.id); setPanelOpen(false) }} onMenu={(element, x, y) => openChatMenu(chat, element, x, y)}>
            <span className="relative"><Avatar appearance={chat.appearance} variant={chat.bot ?? 'cfo'} className="profile-avatar" />{chat.pinned && <span className="profile-badge absolute flex items-center justify-center rounded-full border-[#0d0d0d] bg-[#f59a08]"><Star fill="currentColor" strokeWidth={0} className="text-white" /></span>}</span>
            <span className="profile-name font-medium">{chat.title}</span>{chat.unread && <span className="bot-unread">Unread</span>}
          </PinnedBotButton>
        </div>)}
      </nav>

      <nav className="chat-list min-h-0 flex-1 space-y-2 overflow-y-auto" aria-label="Conversations">
        {Array.from(new Set(conversations.filter(chat => !chat.hidden && !chat.pinned).map(chat => chat.section ?? ''))).map(section => <div key={section} className="chat-section">
          {section && <h2 className="chat-section-title">{section}</h2>}
          {conversations.filter(chat => !chat.hidden && !chat.pinned && (chat.section ?? '') === section).map(chat => <div key={chat.id} className="chat-row" data-menu-open={chatMenu?.id === chat.id} onContextMenu={event => { event.preventDefault(); openChatMenu(chat, event.currentTarget.querySelector<HTMLButtonElement>('.chat-item')!, event.clientX, event.clientY) }}>
            <button data-chat-id={chat.id} onClick={() => selectChat(chat.id)} aria-current={active.id === chat.id ? 'page' : undefined} aria-haspopup="menu" onKeyDown={event => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openChatMenu(chat, event.currentTarget, rect.left + 24, rect.bottom) }
            }} className={`chat-item group flex w-full items-center gap-4 rounded-[18px] text-left transition-colors ${active.id === chat.id ? 'bg-[#222222]' : 'hover:bg-white/[0.045]'}`}>
              <Avatar appearance={chat.appearance} variant={chat.bot ?? 'cfo'} className="chat-avatar shrink-0" />
              <span className="min-w-0 flex-1"><span className="chat-title block font-semibold">{chat.title}</span><span className="chat-preview block truncate text-[#a2a2a2]">{chat.messages.at(-1)?.text || 'Attachment'}</span><span className="chat-flags">{chat.pinned && <span><Pin size={10} aria-hidden="true" /> Pinned</span>}{chat.unread && <span>Unread</span>}</span></span>
            </button>
            <button type="button" className="chat-more" aria-label={`Actions for ${chat.title}`} aria-haspopup="menu" aria-expanded={chatMenu?.id === chat.id} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openChatMenu(chat, event.currentTarget, rect.right, rect.bottom) }}><MoreHorizontal size={17} /></button>
          </div>)}
        </div>)}
      </nav>

      <div className="sidebar-footer flex items-center gap-3">
        <button ref={profileButtonRef} type="button" className="workspace-button flex shrink-0 items-center justify-center rounded-full border border-[#17416c] bg-[#06346f] transition-colors hover:bg-[#104887]" aria-label="Workspace menu" aria-haspopup="menu" aria-expanded={profileOpen} aria-controls="workspace-menu" onClick={event => { if (!profileOpen) { setChatMenu(null); setProfileKeyboard(event.detail === 0); setProfileOpen(true) } }}>
          <svg aria-hidden="true" viewBox="0 0 32 24" className="w-7 fill-white"><path d="M2 11h7v7H2zm8-5h7v7h-7zm8 0h5l7 7v5h-7v-7h-5zM10 13h7v5h-7z" /></svg>
        </button>
        <button className="connect-button flex flex-1 items-center justify-center gap-3 whitespace-nowrap rounded-full border border-white/[0.055] bg-[#202020] font-medium transition-colors hover:bg-[#2a2a2a]" onClick={() => setModal('apps')}>
          <span>Connect apps</span><span className="flex items-center -space-x-0.5"><AppIcon app="drive" /><AppIcon app="calendar" /><AppIcon app="notion" /></span>
        </button>
      </div>
    </aside>

    <main id="chat-content" tabIndex={-1} inert={(isMobile && sidebarOpen) || (panelOverlay && panelOpen)} className="relative flex min-w-0 flex-1 flex-col">
      <header className="chat-header relative flex shrink-0 items-start justify-center">
        <button ref={menuRef} className="icon-button absolute left-4 top-4 md:hidden" aria-label="Open sidebar" aria-controls="chat-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><Menu /></button>
        <h1><button ref={agentTriggerRef} type="button" className="agent-pill inline-flex items-center gap-3 rounded-full border border-white/[0.055] bg-[#1f1f1f]" aria-label={`${active.title} details`} aria-controls="agent-details" aria-expanded={panelOpen} onClick={() => { setPanelInitialTab('Details'); setPanelOpen(open => !open) }}><Avatar appearance={active.appearance} variant={active.bot ?? 'cfo'} className="header-avatar" /><span className="font-semibold">{active.title}</span></button></h1>
      </header>

      {callId === active.id && <VoiceCall key={active.id} name={active.title} accent={botAccent(active)} avatar={<Avatar appearance={active.appearance} variant={active.bot ?? 'cfo'} />} muted={callMuted} onMutedChange={setCallMuted} onClose={endCall} />}

      <section tabIndex={0} className="message-area min-h-0 flex-1 overflow-y-auto" aria-label="Chat messages" aria-live="polite" aria-relevant="additions">
        <p className="chat-date text-center font-medium text-[#969696]">Today {new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date())}</p>
        <div className="messages flex flex-col items-start gap-4">
          {active.messages.map(message => message.kind === 'choices' ? <section key={message.id} className="choice-card animate-message" aria-labelledby={`question-${message.id}`}>
            <h2 id={`question-${message.id}`} className="choice-heading">{message.text}</h2>
            <div className="choice-list">
              {openingChoices.map(choice => <button key={choice.key} type="button" className={`choice-option ${choice.key === 'D' ? 'choice-option-other' : ''}`} disabled={!!typingId || voiceActive || active.messages.some(item => item.role === 'user')} onClick={() => chooseOpening(choice.label)}>
                <span className="choice-key" aria-hidden="true">{choice.key}</span>
                <span>{choice.label}</span>
              </button>)}
            </div>
          </section> : <div key={message.id} className={`message-bubble animate-message whitespace-pre-wrap break-words ${message.role === 'user' ? 'message-user self-end' : 'message-assistant'}`}>
            {message.audio ? <div className="voice-message"><span className="voice-message-label">{message.text}</span><audio controls preload="metadata" src={message.audio.url} aria-label={`Play voice note, ${voiceTime(message.audio.duration)}`} /><span className="voice-message-label">{active.server || active.bot === 'yui' ? 'Voice note' : 'Local recording · No transcript'}</span></div> : message.text}
            {!!message.files?.length && <div className="mt-2 flex flex-wrap gap-2">{message.files.map((file, index) => <span key={`${file}-${index}`} className="inline-flex max-w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm"><FileText size={16} className="shrink-0" /><span className="attachment-name">{file}</span></span>)}</div>}
          </div>)}
          {typingId === active.id && <div className="typing-indicator flex items-center gap-3 pl-3 text-[#777777]" role="status"><Avatar appearance={active.appearance} variant={active.bot ?? 'cfo'} className="typing-avatar" /><span>Typing<span className="typing-dots">...</span></span></div>}
          <div ref={endRef} />
        </div>
      </section>

      <div className="composer-area shrink-0">
        {files.length > 0 && <div className="mb-3 flex flex-wrap gap-2">{files.map((file, index) => <span key={`${file.name}-${index}`} className="flex max-w-64 items-center gap-2 rounded-xl border border-white/10 bg-[#222] px-3 py-2 text-sm"><Paperclip size={14} className="shrink-0" /><span className="attachment-name min-w-0">{file.name}</span><button aria-label={`Remove ${file.name}`} className="remove-file shrink-0 text-neutral-400 hover:text-white" onClick={() => setFiles(current => current.filter((_, i) => i !== index))}><X size={15} /></button></span>)}</div>}
        <div className="voice-error" role="alert">{voice.error && <><p>{voice.error}</p><button type="button" aria-label="Dismiss microphone error" onClick={cancelVoice}><X size={16} /></button></>}</div>
        <div className="sr-only" role="status">{voiceStatus}</div>
        <form className="composer flex items-end gap-3 rounded-[32px] border border-[#484848] bg-[#202020]" onSubmit={event => { event.preventDefault(); sendMessage() }}>
          {voiceActive ? <VoiceNoteControls voice={voice} onCancel={cancelVoice} /> : <>
          <input ref={fileRef} type="file" multiple className="hidden" aria-label="Attach files" onChange={event => { setFiles(current => [...current, ...Array.from(event.target.files ?? [])]); event.target.value = ''; inputRef.current?.focus() }} />
          <button type="button" className="composer-icon attachment-button" aria-label="Attach files (local preview only)" title="Attach files (local preview only)" onClick={() => fileRef.current?.click()}><Plus strokeWidth={2.2} /></button>
          <label htmlFor="message-input" className="sr-only">Message {active.title}</label>
          <textarea id="message-input" name="message" ref={inputRef} className="message-input min-w-0 flex-1 resize-none bg-transparent outline-none placeholder:text-[#737373]" rows={1} spellCheck={spellCheck} aria-label={`Message ${active.title}`} placeholder={active.messages.some(message => message.role === 'user') ? `Message ${active.title}` : 'Type your answer, or talk about something else'} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendMessage() } }} />
          <div className="flex shrink-0 items-center gap-3">
            {callId !== active.id && <button type="button" className="composer-icon mic-button" aria-label="Record voice note" title="Record voice note (local only)" onClick={() => { void voice.start() }}><Mic strokeWidth={1.8} /></button>}
            {draft.trim() || files.length ? <button type="submit" disabled={!!typingId} className="composer-icon send-button disabled:cursor-wait disabled:opacity-40" aria-label="Send message"><ArrowUp strokeWidth={2.3} /></button> : callId === active.id ? <button ref={callTriggerRef} type="button" className="composer-icon voice-live-mic" style={{ '--call-accent': botAccent(active) } as React.CSSProperties} aria-label={callMuted ? 'Unmute voice chat' : 'Mute voice chat'} aria-pressed={callMuted} onClick={() => setCallMuted(muted => !muted)}>{callMuted ? <MicOff strokeWidth={1.8} /> : <Mic strokeWidth={1.8} />}</button> : <button ref={callTriggerRef} type="button" className="composer-icon send-button" aria-label="Start voice chat" title="Voice chat (local demo)" onClick={() => { voice.cancel(); setPanelOpen(false); setCallMuted(false); setCallId(active.id) }}><AudioLines strokeWidth={2.2} /></button>}
          </div>
          </>}
        </form>
        {voiceActive && <p className="voice-help">Local recording only · No upload or transcription. Your message draft is kept.</p>}
      </div>
    </main>

    {panelOpen && panelOverlay && <div className="agent-panel-backdrop" aria-hidden="true" onClick={() => setPanelOpen(false)} />}
    <AgentPanel name={active.title} open={panelOpen} initialTab={panelInitialTab} overlay={panelOverlay} triggerRef={agentTriggerRef} onClose={() => setPanelOpen(false)} onNotice={setNotice} avatar={<Avatar appearance={active.appearance} variant={active.bot ?? 'cfo'} className="details-avatar" />} files={active.messages.flatMap(message => message.files ?? [])} />

    {chatMenu && <ChatContextMenu key={`${chatMenu.id}-${chatMenu.x}-${chatMenu.y}`} target={chatMenu} onClose={() => setChatMenu(null)} onAction={action => runChatAction(chatMenu, action)} />}
    {profileOpen && profileButtonRef.current && <ProfileMenu trigger={profileButtonRef.current} keyboard={profileKeyboard} onClose={() => setProfileOpen(false)} onSelect={selectProfile} />}
    {chatAction && <ChatActionDialog action={chatAction.action} title={chatAction.title} onClose={() => setChatAction(null)} onConfirm={confirmChatAction} />}

    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} conversations={conversations.map(chat => ({ id: chat.id, title: chat.title, detail: chat.messages.at(-1)?.text || 'Attachment', keywords: chat.messages.map(message => message.text).join(' '), icon: <Avatar appearance={chat.appearance} variant={chat.bot ?? 'cfo'} className="palette-avatar" />, run: () => { selectChat(chat.id); setPanelOpen(false) } }))} workspaceIcon={<Avatar variant="yui" className="palette-avatar" />} onWorkspace={() => setNotice('Yui workspace · Frontend template. Account settings are not connected yet.')} onNewChat={() => { newChat(); setPanelOpen(false) }} onComputer={() => { setSidebarOpen(false); setPanelInitialTab('Computer'); setPanelOpen(true) }} onApps={() => setModal('apps')} />

    <ConnectAppsDialog open={modal === 'apps'} onClose={() => setModal(null)} />
    <SettingsDialog open={modal === 'settings'} onClose={() => setModal(null)} spellCheck={spellCheck} onSpellCheck={setSpellCheck} />
    {modal === 'create-bot' && <CreateBotDialog onClose={() => setModal(null)} onCreate={createBot} />}

    <div role="status" aria-atomic="true" className="sr-only">{notice}</div>
    {notice && <div className="toast fixed bottom-24 left-1/2 z-50 flex w-[calc(100%_-_32px)] max-w-md -translate-x-1/2 items-start gap-3 rounded-2xl border border-white/10 bg-[#292929] px-5 py-4 text-sm leading-relaxed text-neutral-200 shadow-2xl"><span className="flex-1">{notice}</span><button className="toast-dismiss mt-0.5 text-neutral-400 hover:text-white" onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={16} /></button></div>}
  </div>
}
