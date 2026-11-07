import React, { useEffect, useRef, useState } from 'react'
import { ArrowUp, AudioLines, Bot, Copy, FileText, Menu, Mic, MicOff, Paperclip, Plus, Search, Trash2, X } from 'lucide-react'
import { ulid } from 'ulidx'
import { AgentPanel } from './AgentPanel'
import { CommandPalette } from './CommandPalette'
import { ConnectAppsDialog } from './ConnectAppsDialog'
import { CreateBotDialog } from './CreateBotDialog'
import { SettingsDialog } from './SettingsDialog'
import { BotAvatar as Avatar } from './BotAvatar'
import { ChatContextMenu, type ChatAction, type ChatMenuItem, type ChatMenuTarget } from './ChatContextMenu'
import { ProfileMenu, type ProfileAction } from './ProfileMenu'
import { ChatActionDialog } from './ChatActionDialog'
import { PinnedBotButton } from './PinnedBotButton'
import { useVoiceRecorder, voiceTime, type VoiceNote } from './useVoiceRecorder'
import { VoiceNoteControls } from './VoiceNoteControls'
import { VoiceCall } from './VoiceCall'
import { useSession } from './SessionContext.tsx'
import { ApiError, deleteBot, fetchThreadMessages, listBots, listThreads, resolveActiveKind, streamTurn, uploadAudioNote } from './api.ts'
import type { BotDto, MessageDto } from '../shared/app.ts'
import type { YuiEvent } from '../shared/engine.ts'
import './styles.css'

// crypto.randomUUID hanya tersedia di secure context (https/localhost) — di
// LAN http://<ip> ia undefined, jadi jatuh ke ulid agar id tetap tergenerasi.
const newId = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : ulid())

type Message = { id: string; role: 'assistant' | 'user'; text: string; files?: string[]; audio?: { url: string; duration: number } }
// Multi-bot harness: one conversation per bot. Before the bot's first turn
// the id is the local placeholder `bot:<botId>` (server: false) and the turn
// is sent WITHOUT threadId but WITH botId; the first thread.updated migrates
// the id to the server thread id (server: true, loaded: true). `botName` is
// the display identity everywhere (header + sidebar + panels) — the derived
// thread title is server-internal and NEVER adopted for display.
// `loaded` marks a server conversation whose history is already in state
// (lazy-loaded once, never refetched during the session).
type Conversation = { id: string; botId: string; botName: string; messages: Message[]; server?: boolean; loaded?: boolean }
// Per-turn stream context: the conversation the turn was sent from, plus the
// server thread id once the first thread.updated event reveals it.
type TurnState = { chatId: string; threadId?: string }
type Modal = 'apps' | 'create-bot' | 'settings' | null

// Client-side mirror of the server's 5 MB audio cap: a UX guard that skips
// the request with a clear message, not a security boundary — the server
// rejects oversized blobs on its own (src/server/audio/routes.ts).
const VOICE_NOTE_MAX_BYTES = 5 * 1024 * 1024

/** Conversation placeholder id for a bot whose thread is not created yet. */
function botPlaceholderId(botId: string): string {
  return `bot:${botId}`
}

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

/** Sidebar + pane "no bots yet" empty state (I/O matrix row "User tanpa bot"). */
export function BotsEmptyState({ onCreate }: { onCreate: () => void }) {
  return <div className="bots-empty panel-empty">
    <Bot size={28} aria-hidden="true" />
    <p>Create your first bot</p>
    <span>Every bot is its own assistant with a name and persona, and keeps its own conversation on your account.</span>
    <button type="button" className="bots-empty-cta" onClick={onCreate}>Create a bot</button>
  </div>
}

function AppIcon({ app }: { app: 'drive' | 'calendar' | 'notion' }) {
  if (app === 'drive') return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0DA960" d="m9 3-7 12 4 7 7-12z" /><path fill="#FDCB42" d="m9 3 8 0 7 12-8 0z" /><path fill="#4385F5" d="m2 15 14 0 8 0-4 7H6z" /></svg>
  if (app === 'calendar') return <span aria-hidden="true" className="calendar-icon"><span />31</span>
  return <span aria-hidden="true" className="notion-icon">N</span>
}

export default function App() {
  const { signOut } = useSession()
  // Bot conversations replace the demo seeds: the list starts EMPTY and is
  // built on mount from GET /api/bots + GET /api/threads (each bot gets its
  // latest thread, or an empty conversation whose thread is lazy-created on
  // the bot's first turn).
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = conversations.find(chat => chat.id === activeId)
  // Mount fetch settled: the empty state only shows after the load, so a
  // user WITH bots never sees "create your first bot" flash first.
  const [ready, setReady] = useState(false)
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
  const [chatAction, setChatAction] = useState<{ id: string; botId: string; title: string; action: 'delete' } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const audioUrls = useRef(new Set<string>())
  const voice = useVoiceRecorder(active?.id ?? '', sendServerVoiceNote)
  const voiceActive = voice.phase !== 'idle'
  const voiceStatus = voice.phase === 'recording' ? 'Recording voice note. Stop to send, or cancel.' : voice.phase === 'requesting' ? 'Waiting for microphone permission. Allow access in your browser, or cancel.' : voice.phase === 'stopping' ? 'Preparing voice note.' : ''

  useEffect(() => () => audioUrls.current.forEach(url => URL.revokeObjectURL(url)), [])

  // Mount: build the bot conversations. GET /api/bots owns the roster (oldest
  // first = shortcut row order); GET /api/threads (newest first) binds each
  // bot to its LATEST thread — history lazy-loads on first selection. Threads
  // without a live bot row cannot occur (DELETE /api/bots cascades); any that
  // ever appear are skipped rather than shown under a nameless bot.
  useEffect(() => {
    let cancelled = false
    Promise.all([listBots(), listThreads()])
      .then(([bots, threads]) => {
        if (cancelled) return
        const latestByBot = new Map<string, { id: string }>()
        for (const thread of threads) {
          if (thread.botId !== null && !latestByBot.has(thread.botId)) latestByBot.set(thread.botId, thread)
        }
        const mapped = bots.map<Conversation>(bot => {
          const thread = latestByBot.get(bot.id)
          return thread === undefined
            ? { id: botPlaceholderId(bot.id), botId: bot.id, botName: bot.name, messages: [] }
            : { id: thread.id, botId: bot.id, botName: bot.name, server: true, messages: [] }
        })
        setConversations(mapped)
        setActiveId(current => current !== null && mapped.some(chat => chat.id === current) ? current : mapped[0]?.id ?? null)
        setReady(true)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setReady(true)
        setNotice(error instanceof ApiError && error.code === 'unauthorized'
          ? 'Session expired. Sign in again.'
          : 'Could not load your bots and conversations. Reload to try again.')
      })
    return () => { cancelled = true }
  }, [])

  // Server voice turn: size guard → optimistic voice bubble → upload → turn
  // {audioId} (+ botId for the thread-creating turn) → streamed events,
  // mirroring sendServerMessage. Every failure stage releases the composer
  // and leaves no orphaned bubble or object URL behind.
  function sendServerVoiceNote(note: VoiceNote, chatId: string) {
    const target = conversations.find(chat => chat.id === chatId)
    if (target === undefined) return
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
        const turn: TurnState = { chatId, threadId: target.server === true ? chatId : undefined }
        // Same per-send kind resolution as a text turn (two parallel GETs): a
        // failure never blocks the turn — it goes out without `kind`.
        void resolveActiveKind()
          .catch(() => null)
          .then(kind => streamTurn({ audioId: uploaded.id, threadId: turn.threadId, botId: target.server === true ? undefined : target.botId, clientToken: newId(), kind: kind ?? undefined }, event => applyTurnEvent(turn, event)))
          .catch((error: unknown) => {
            // Pre-stream rejection or mid-stream failure: identical handling to
            // sendServerMessage. The optimistic voice bubble stays (v1 has no
            // auto-retry) and still plays — its object URL is backed by the
            // local blob, not the server.
            streamingMessageRef.current = null
            setTypingId(current => current === (turn.threadId ?? turn.chatId) ? null : current)
            if (error instanceof ApiError && error.code === 'unauthorized') setNotice('Session expired. Sign in again.')
            else if (error instanceof ApiError) setNotice(error.message)
            else setNotice('Could not reach the bot. Check your connection and try again.')
          })
      })
  }
  function cancelVoice() {
    voice.cancel()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

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
  }, [active?.id, active?.messages.length, typingId])
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
  useEffect(() => { setCallId(null); setCallMuted(false) }, [active?.id])

  function newChat() {
    setPanelOpen(false)
    setModal('create-bot')
  }

  // A newly created bot joins as an empty conversation (thread lazy-created
  // on its first turn) and becomes the active one (I/O matrix row "Buat bot").
  function handleBotCreated(bot: BotDto) {
    const chat: Conversation = { id: botPlaceholderId(bot.id), botId: bot.id, botName: bot.name, messages: [] }
    setConversations(current => [...current, chat])
    setActiveId(chat.id)
    setDraft('')
    setFiles([])
    setSidebarOpen(false)
    requestAnimationFrame(() => inputRef.current?.focus())
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
    setActiveId(id)
    setDraft('')
    setFiles([])
    setSidebarOpen(false)
    setModal(null)
  }

  function openChatMenu(chat: Conversation, trigger: HTMLElement, x: number, y: number) {
    setProfileOpen(false)
    setChatMenu({ id: chat.id, title: chat.botName, x, y, trigger })
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

  // The per-bot menu offers only what a server bot supports: copy the
  // conversation id, or delete the bot (server cascade). Rename/pin/section
  // were demo-seed features — bots are immutable after creation.
  const botMenuItems: ChatMenuItem[] = [
    { id: 'copy', label: 'Copy conversation ID', icon: Copy, separator: true },
    { id: 'delete', label: 'Delete bot', icon: Trash2 },
  ]

  function runChatAction(target: ChatMenuTarget, action: ChatAction) {
    if (action === 'delete') {
      const chat = conversations.find(item => item.id === target.id)
      if (chat !== undefined) setChatAction({ id: chat.id, botId: chat.botId, title: chat.botName, action })
    } else if (action === 'copy') {
      void navigator.clipboard.writeText(target.id).then(() => setNotice('Conversation ID copied.'), () => setNotice('Unable to copy. Clipboard access is blocked by your browser.'))
    }
  }

  // Deleting a bot calls DELETE /api/bots/:id: the server cascades the bot's
  // threads and their messages. On success the conversation row goes away and
  // the active slot moves to another bot — or the empty state (no synthetic
  // fallback chat anymore). On failure everything stays put.
  function confirmChatAction() {
    if (!chatAction) return
    const target = chatAction
    void deleteBot(target.botId)
      .then(() => {
        conversations.find(chat => chat.id === target.id)?.messages.forEach(message => {
          if (message.audio) { URL.revokeObjectURL(message.audio.url); audioUrls.current.delete(message.audio.url) }
        })
        const remaining = conversations.filter(chat => chat.id !== target.id)
        setConversations(remaining)
        if (activeId === target.id) {
          const next = remaining[0]
          setActiveId(next?.id ?? null)
          setDraft('')
          setFiles([])
          if (typingId === target.id) setTypingId(null)
          // The reselection can land on a server thread that was never
          // selected — make sure its history still lazy-loads once.
          if (next?.server && next.loaded !== true) loadHistory(next.id)
        }
        setNotice('Bot deleted.')
        sidebarRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Search conversations"]')?.focus()
      })
      .catch((error: unknown) => {
        setNotice(error instanceof ApiError && error.code === 'unauthorized'
          ? 'Session expired. Sign in again.'
          : error instanceof ApiError
            ? error.message
            : 'Could not delete the bot. Check your connection and try again.')
      })
  }

  // Apply one streamed server event to conversation state. Every update goes
  // through functional setConversations, so events arriving after the user
  // deleted the conversation simply find no match and are ignored silently.
  function applyTurnEvent(turn: TurnState, event: YuiEvent): void {
    if (event.type === 'thread.updated') {
      if (turn.threadId === undefined) {
        // First event of a thread-creating turn: migrate the placeholder
        // conversation id (`bot:…`) to the server thread id — the conversation
        // becomes server-backed from here on. The bot's own name stays the
        // display identity; the derived title in the event is IGNORED for
        // display (server-internal, for future search). Its local transcript
        // already IS the thread's full history, so it counts as loaded.
        turn.threadId = event.threadId
        const localId = turn.chatId
        const threadId = event.threadId
        setConversations(current => {
          const index = current.findIndex(chat => chat.id === localId)
          if (index === -1) return current
          const migrated: Conversation = { ...current[index], id: threadId, server: true, loaded: true }
          // A delayed mount response can already have added the thread's own
          // row under the new thread id — drop it too, or the id would exist
          // twice (duplicate keys; every event upsert would hit both rows).
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

  // Server turn for the active bot: optimistic user bubble → POST
  // /api/engine/turn → streamed events grow the assistant bubble in place.
  // A placeholder conversation (no thread yet) sends botId and no threadId —
  // the server creates the thread bound to that bot; a server conversation
  // sends threadId only (the thread's own bot governs the turn).
  function sendServerMessage(text: string) {
    const chat = active
    if (chat === undefined) return
    if (!text) {
      // The server demands non-empty content; attachments alone stay local.
      setNotice('Type a message to send')
      return
    }
    const chatId = chat.id
    const turn: TurnState = { chatId, threadId: chat.server === true ? chatId : undefined }
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
      .then(kind => streamTurn({ content: text, threadId: turn.threadId, botId: chat.server === true ? undefined : chat.botId, clientToken: newId(), kind: kind ?? undefined }, event => applyTurnEvent(turn, event)))
      .catch((error: unknown) => {
        // Pre-stream rejection or mid-stream failure: release the composer and
        // surface a notice — turn-scoped, so a stale turn's rejection cannot
        // release a newer turn still streaming. The optimistic user bubble
        // stays (v1 has no auto-retry); an in-progress bubble keeps its last text.
        streamingMessageRef.current = null
        setTypingId(current => current === (turn.threadId ?? turn.chatId) ? null : current)
        if (error instanceof ApiError && error.code === 'unauthorized') setNotice('Session expired. Sign in again.')
        else if (error instanceof ApiError) setNotice(error.message)
        else setNotice('Could not reach the bot. Check your connection and try again.')
      })
  }

  function sendMessage() {
    const text = draft.trim()
    if ((!text && files.length === 0) || typingId || voiceActive) return
    sendServerMessage(text)
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

      {/* Shortcut row = every bot (one conversation per bot, roster order). */}
      <nav className="profile bot-shortcuts min-h-0 flex-1 max-h-none" aria-label="Bots">
        {conversations.map(chat => <div key={chat.id} className="bot-shortcut-wrap">
          <PinnedBotButton id={chat.id} title={chat.botName} active={activeId === chat.id} onSelect={() => { selectChat(chat.id); setPanelOpen(false) }} onMenu={(element, x, y) => openChatMenu(chat, element, x, y)}>
            <span className="relative"><Avatar variant="yui" className="profile-avatar" /></span>
            <span className="profile-name font-medium">{chat.botName}</span>
          </PinnedBotButton>
        </div>)}
      </nav>

      {ready && conversations.length === 0 && <div className="chat-list"><BotsEmptyState onCreate={newChat} /></div>}

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
        {active && <h1><button ref={agentTriggerRef} type="button" className="agent-pill inline-flex items-center gap-3 rounded-full border border-white/[0.055] bg-[#1f1f1f]" aria-label={`${active.botName} details`} aria-controls="agent-details" aria-expanded={panelOpen} onClick={() => { setPanelInitialTab('Details'); setPanelOpen(open => !open) }}><Avatar variant="yui" className="header-avatar" /><span className="font-semibold">{active.botName}</span></button></h1>}
      </header>

      {active && callId === active.id && <VoiceCall key={active.id} name={active.botName} accent="#ffffff" avatar={<Avatar variant="yui" />} muted={callMuted} onMutedChange={setCallMuted} onClose={endCall} />}

      {active === undefined ? (!ready ? <section className="message-area min-h-0 flex-1 overflow-y-auto" aria-label="Chat messages" /> : <section className="message-area bots-empty-area min-h-0 flex-1 overflow-y-auto" aria-label="Chat messages">
        <BotsEmptyState onCreate={newChat} />
      </section>) : <section tabIndex={0} className="message-area min-h-0 flex-1 overflow-y-auto" aria-label="Chat messages" aria-live="polite" aria-relevant="additions">
        <p className="chat-date text-center font-medium text-[#969696]">Today {new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date())}</p>
        <div className="messages flex flex-col items-start gap-4">
          {active.messages.map(message => <div key={message.id} className={`message-bubble animate-message whitespace-pre-wrap break-words ${message.role === 'user' ? 'message-user self-end' : 'message-assistant'}`}>
            {message.audio ? <div className="voice-message"><span className="voice-message-label">{message.text}</span><audio controls preload="metadata" src={message.audio.url} aria-label={`Play voice note, ${voiceTime(message.audio.duration)}`} /><span className="voice-message-label">Voice note</span></div> : message.text}
            {!!message.files?.length && <div className="mt-2 flex flex-wrap gap-2">{message.files.map((file, index) => <span key={`${file}-${index}`} className="inline-flex max-w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm"><FileText size={16} className="shrink-0" /><span className="attachment-name">{file}</span></span>)}</div>}
          </div>)}
          {typingId === active.id && <div className="typing-indicator flex items-center gap-3 pl-3 text-[#777777]" role="status"><Avatar variant="yui" className="typing-avatar" /><span>Typing<span className="typing-dots">...</span></span></div>}
          <div ref={endRef} />
        </div>
      </section>}

      {active !== undefined && <div className="composer-area shrink-0">
        {files.length > 0 && <div className="mb-3 flex flex-wrap gap-2">{files.map((file, index) => <span key={`${file.name}-${index}`} className="flex max-w-64 items-center gap-2 rounded-xl border border-white/10 bg-[#222] px-3 py-2 text-sm"><Paperclip size={14} className="shrink-0" /><span className="attachment-name min-w-0">{file.name}</span><button aria-label={`Remove ${file.name}`} className="remove-file shrink-0 text-neutral-400 hover:text-white" onClick={() => setFiles(current => current.filter((_, i) => i !== index))}><X size={15} /></button></span>)}</div>}
        <div className="voice-error" role="alert">{voice.error && <><p>{voice.error}</p><button type="button" aria-label="Dismiss microphone error" onClick={cancelVoice}><X size={16} /></button></>}</div>
        <div className="sr-only" role="status">{voiceStatus}</div>
        <form className="composer flex items-end gap-3 rounded-[32px] border border-[#484848] bg-[#202020]" onSubmit={event => { event.preventDefault(); sendMessage() }}>
          {voiceActive ? <VoiceNoteControls voice={voice} onCancel={cancelVoice} /> : <>
          <input ref={fileRef} type="file" multiple className="hidden" aria-label="Attach files" onChange={event => { setFiles(current => [...current, ...Array.from(event.target.files ?? [])]); event.target.value = ''; inputRef.current?.focus() }} />
          <button type="button" className="composer-icon attachment-button" aria-label="Attach files (local preview only)" title="Attach files (local preview only)" onClick={() => fileRef.current?.click()}><Plus strokeWidth={2.2} /></button>
          <label htmlFor="message-input" className="sr-only">Message {active.botName}</label>
          <textarea id="message-input" name="message" ref={inputRef} className="message-input min-w-0 flex-1 resize-none bg-transparent outline-none placeholder:text-[#737373]" rows={1} spellCheck={spellCheck} aria-label={`Message ${active.botName}`} placeholder={`Message ${active.botName}`} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendMessage() } }} />
          <div className="flex shrink-0 items-center gap-3">
            {callId !== active.id && <button type="button" className="composer-icon mic-button" aria-label="Record voice note" title="Record voice note" onClick={() => { void voice.start() }}><Mic strokeWidth={1.8} /></button>}
            {draft.trim() || files.length ? <button type="submit" disabled={!!typingId} className="composer-icon send-button disabled:cursor-wait disabled:opacity-40" aria-label="Send message"><ArrowUp strokeWidth={2.3} /></button> : callId === active.id ? <button ref={callTriggerRef} type="button" className="composer-icon voice-live-mic" style={{ '--call-accent': '#ffffff' } as React.CSSProperties} aria-label={callMuted ? 'Unmute voice chat' : 'Mute voice chat'} aria-pressed={callMuted} onClick={() => setCallMuted(muted => !muted)}>{callMuted ? <MicOff strokeWidth={1.8} /> : <Mic strokeWidth={1.8} />}</button> : <button ref={callTriggerRef} type="button" className="composer-icon send-button" aria-label="Start voice chat" title="Voice chat (local demo)" onClick={() => { voice.cancel(); setPanelOpen(false); setCallMuted(false); setCallId(active.id) }}><AudioLines strokeWidth={2.2} /></button>}
          </div>
          </>}
        </form>
        {voiceActive && <p className="voice-help">Your message draft is kept while you record.</p>}
      </div>}
    </main>

    {panelOpen && panelOverlay && <div className="agent-panel-backdrop" aria-hidden="true" onClick={() => setPanelOpen(false)} />}
    {active && <AgentPanel name={active.botName} open={panelOpen} initialTab={panelInitialTab} overlay={panelOverlay} triggerRef={agentTriggerRef} onClose={() => setPanelOpen(false)} onNotice={setNotice} avatar={<Avatar variant="yui" className="details-avatar" />} files={active.messages.flatMap(message => message.files ?? [])} />}

    {chatMenu && <ChatContextMenu key={`${chatMenu.id}-${chatMenu.x}-${chatMenu.y}`} target={chatMenu} items={botMenuItems} onClose={() => setChatMenu(null)} onAction={action => runChatAction(chatMenu, action)} />}
    {profileOpen && profileButtonRef.current && <ProfileMenu trigger={profileButtonRef.current} keyboard={profileKeyboard} onClose={() => setProfileOpen(false)} onSelect={selectProfile} />}
    {chatAction && <ChatActionDialog action={chatAction.action} title={chatAction.title} onClose={() => setChatAction(null)} onConfirm={() => confirmChatAction()} />}

    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} conversations={conversations.map(chat => ({ id: chat.id, title: chat.botName, detail: chat.messages.at(-1)?.text || 'New conversation', keywords: chat.messages.map(message => message.text).join(' '), icon: <Avatar variant="yui" className="palette-avatar" />, run: () => { selectChat(chat.id); setPanelOpen(false) } }))} workspaceIcon={<Avatar variant="yui" className="palette-avatar" />} onWorkspace={() => setNotice('Yui workspace · Frontend template. Account settings are not connected yet.')} onNewChat={() => { newChat(); setPanelOpen(false) }} onComputer={() => { if (!active) return; setSidebarOpen(false); setPanelInitialTab('Computer'); setPanelOpen(true) }} onApps={() => setModal('apps')} />

    <ConnectAppsDialog open={modal === 'apps'} onClose={() => setModal(null)} />
    <SettingsDialog open={modal === 'settings'} onClose={() => setModal(null)} spellCheck={spellCheck} onSpellCheck={setSpellCheck} />
    {modal === 'create-bot' && <CreateBotDialog onClose={() => setModal(null)} onCreated={handleBotCreated} />}

    <div role="status" aria-atomic="true" className="sr-only">{notice}</div>
    {notice && <div className="toast fixed bottom-24 left-1/2 z-50 flex w-[calc(100%_-_32px)] max-w-md -translate-x-1/2 items-start gap-3 rounded-2xl border border-white/10 bg-[#292929] px-5 py-4 text-sm leading-relaxed text-neutral-200 shadow-2xl"><span className="flex-1">{notice}</span><button className="toast-dismiss mt-0.5 text-neutral-400 hover:text-white" onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={16} /></button></div>}
  </div>
}
