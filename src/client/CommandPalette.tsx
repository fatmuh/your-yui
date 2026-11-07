import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, CornerDownLeft, Keyboard, Monitor, Plus, Search, Settings, Shield, Users, X } from 'lucide-react'
import { useAnimatedDialog } from './useAnimatedDialog'

export type PaletteEntry = { id: string; title: string; detail?: string; keywords?: string; icon: ReactNode; run: () => void }
type Page = 'commands' | 'shortcuts' | 'general' | 'permissions' | 'group'
type Props = {
  open: boolean
  onClose: () => void
  conversations: PaletteEntry[]
  onNewChat: () => void
  onComputer: () => void
  onApps: () => void
  workspaceIcon: ReactNode
  onWorkspace: () => void
}

export function CommandPalette({ open, onClose, conversations, onNewChat, onComputer, onApps, workspaceIcon, onWorkspace }: Props) {
  const { dialogRef, close } = useAnimatedDialog(open, onClose)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<(HTMLDivElement | null)[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [page, setPage] = useState<Page>('commands')
  const commands: PaletteEntry[] = [
    { id: 'workspace', title: 'Workspace', detail: 'Frontend template · Account information', icon: workspaceIcon, run: onWorkspace },
    ...conversations,
    { id: 'new', title: 'New Bot', detail: 'Choose a name and avatar for a local demo bot', icon: <Plus />, run: onNewChat },
    { id: 'group', title: 'New group chat', icon: <Users />, run: () => setPage('group') },
    { id: 'shortcuts', title: 'Keyboard shortcuts', detail: 'Help', icon: <Keyboard />, run: () => setPage('shortcuts') },
    { id: 'general', title: 'Settings: General', detail: 'Settings', icon: <Settings />, run: () => setPage('general') },
    { id: 'computer', title: 'Settings: Computer', detail: 'Settings', icon: <Monitor />, run: onComputer },
    { id: 'permissions', title: 'Settings: Permissions', detail: 'Settings', icon: <Shield />, run: () => setPage('permissions') },
  ]
  const results = commands.filter(item => `${item.title} ${item.detail ?? ''} ${item.keywords ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const activeIndex = Math.min(selected, Math.max(0, results.length - 1))
  const titles: Record<Page, string> = { commands: 'Search commands and conversations', shortcuts: 'Keyboard shortcuts', general: 'Settings: General', permissions: 'Settings: Permissions', group: 'New group chat' }

  useEffect(() => {
    if (open) {
      setQuery(''); setSelected(0); setPage('commands')
      inputRef.current?.focus()
    }
  }, [open])
  useEffect(() => { optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' }) }, [activeIndex, query])
  useEffect(() => {
    if (!open) return
    if (page === 'commands') inputRef.current?.focus()
    else dialogRef.current?.querySelector<HTMLButtonElement>('.palette-page-header button')?.focus()
  }, [page, open])

  function run(entry: PaletteEntry) {
    if (['group', 'shortcuts', 'general', 'permissions'].includes(entry.id)) entry.run()
    else void close(entry.run)
  }

  return <dialog ref={dialogRef} className="command-palette t-modal" aria-label={titles[page]} onCancel={event => { event.preventDefault(); close() }} onClick={event => {
    if (event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
  }}>
    {page === 'commands' ? <>
      <div className="palette-search">
        <Search size={19} aria-hidden="true" />
        <input ref={inputRef} id="palette-search" name="command" autoComplete="off" role="combobox" aria-label="Search commands and conversations" aria-autocomplete="list" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={results.length ? `palette-option-${results[activeIndex].id}` : undefined} placeholder="Search" value={query} onChange={event => { setQuery(event.target.value); setSelected(0) }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (results.length) setSelected((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length)
          } else if (event.key === 'Enter') { event.preventDefault(); if (results[activeIndex]) run(results[activeIndex]) }
        }} />
        <button type="button" className="palette-close" aria-label="Close command palette" onClick={() => void close()}><X size={17} /></button>
      </div>
      <div id="palette-results" className="palette-results" role="listbox" aria-label="Commands and conversations">
        {results.map((item, index) => <div key={item.id} ref={element => { optionRefs.current[index] = element }} id={`palette-option-${item.id}`} role="option" aria-selected={index === activeIndex} className={`palette-option ${index === activeIndex ? 'is-selected' : ''}`} onPointerMove={event => { if (event.pointerType === 'mouse') setSelected(index) }} onMouseDown={event => event.preventDefault()} onClick={() => run(item)}>
          <span className="palette-option-icon" aria-hidden="true">{item.icon}</span>
          <span className="palette-option-copy"><span className="palette-option-title">{item.title}</span>{item.detail && <span className="palette-option-detail">{item.detail}</span>}</span>
        </div>)}
      </div>
      {!results.length && <p className="palette-empty">No results for “{query}”. Try another search or <button type="button" onClick={() => { setQuery(''); inputRef.current?.focus() }}>clear search</button>.</p>}
      <div className="sr-only" role="status">{open && page === 'commands' ? `${results.length} results` : ''}</div>
      <footer className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><CornerDownLeft size={12} aria-hidden="true" /> Select</span><span><kbd>esc</kbd> Close</span></footer>
    </> : <>
      <header className="palette-page-header"><button type="button" className="palette-close" aria-label="Back to commands" onClick={() => setPage('commands')} autoFocus><ArrowLeft size={18} /></button><h2>{titles[page]}</h2><button type="button" className="palette-close" aria-label="Close command palette" onClick={() => void close()}><X size={17} /></button></header>
      <div className="palette-page-content">
        {page === 'shortcuts' && <dl className="shortcut-list"><div><dt>Open command palette</dt><dd><kbd>Ctrl / ⌘</kbd> <kbd>K</kbd></dd></div><div><dt>Navigate commands</dt><dd><kbd>↑</kbd> <kbd>↓</kbd></dd></div><div><dt>Run selected command</dt><dd><kbd>Enter</kbd></dd></div><div><dt>Close dialog or panel</dt><dd><kbd>Esc</kbd></dd></div><div><dt>Send message</dt><dd><kbd>Enter</kbd></dd></div><div><dt>New line in message</dt><dd><kbd>Shift</kbd> <kbd>Enter</kbd></dd></div></dl>}
        {page === 'general' && <><p>Yui is a frontend template. Conversations and settings are stored in memory and reset when you reload.</p><button className="palette-action" onClick={() => void close(onApps)}>Connect apps · Demo</button></>}
        {page === 'permissions' && <><p>No account, microphone, or computer access is enabled.</p><p>File attachments stay on your device. This template displays file names only and does not upload their contents.</p></>}
        {page === 'group' && <><p>Group chat is not connected in this template. Create a local demo bot instead.</p><button className="palette-action" onClick={() => void close(onNewChat)}>Start a new chat</button></>}
      </div>
    </>}
  </dialog>
}
