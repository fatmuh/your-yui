import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check, FileText, Monitor, Upload, X } from 'lucide-react'
import { SelectMenu } from './SelectMenu'

const tabs = ['Details', 'Library', 'Computer'] as const
type Tab = typeof tabs[number]

type AgentPanelProps = {
  open: boolean
  name: string
  initialTab?: Tab
  overlay: boolean
  avatar: ReactNode
  triggerRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onNotice: (message: string) => void
  files: string[]
}

export function AgentPanel({ name, open, initialTab = 'Details', overlay, avatar, triggerRef, onClose, onNotice, files }: AgentPanelProps) {
  const [tab, setTab] = useState<Tab>('Details')
  const [voice, setVoice] = useState('Helix')
  const [speed, setSpeed] = useState('1x')
  const [language, setLanguage] = useState('Auto-detect')
  const [copied, setCopied] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => { if (open) setTab(initialTab) }, [open, initialTab])

  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    closeRef.current?.focus({ preventScroll: true })
    return () => { trigger?.focus({ preventScroll: true }) }
  }, [open, triggerRef])

  useEffect(() => {
    if (!open) return
    function handleKey(event: KeyboardEvent) {
      if (document.querySelector('dialog[open], [role="listbox"]:popover-open')) return
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (!overlay || event.key !== 'Tab') return
      const elements = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0)
      if (!elements.length) return
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, overlay, onClose])

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      onNotice('App link copied. Demo conversations are local and are not included in the link.')
    } catch {
      onNotice('Unable to copy the link. Copy the address from your browser instead.')
    }
  }

  return <div className="agent-panel-slot" data-open={open}>
    <aside ref={panelRef} id="agent-details" className="agent-panel t-panel-slide" data-open={open} inert={!open} aria-hidden={!open} role={overlay ? 'dialog' : 'complementary'} aria-modal={open && overlay ? true : undefined} aria-labelledby="agent-panel-title">
      <div className="agent-panel-toolbar">
        <button type="button" className="icon-button" aria-label="Copy app link" title="Copy app link" onClick={copyLink}>{copied ? <Check size={19} /> : <Upload size={19} />}</button>
        <button ref={closeRef} type="button" className="icon-button" aria-label={`Close ${name} panel`} title="Close panel" onClick={onClose}><X size={20} /></button>
      </div>
      <div className="agent-panel-profile">{avatar}<h2 id="agent-panel-title">{name}</h2></div>
      <div className="agent-panel-tabs" role="tablist" aria-label={`${name} settings`}>
        {tabs.map((item, index) => <button key={item} ref={element => { tabRefs.current[index] = element }} id={`agent-tab-${item.toLowerCase()}`} type="button" role="tab" aria-selected={tab === item} aria-controls={`agent-pane-${item.toLowerCase()}`} tabIndex={tab === item ? 0 : -1} onClick={() => setTab(item)} onKeyDown={event => {
          let next = index
          if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
          else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = tabs.length - 1
          else return
          event.preventDefault()
          setTab(tabs[next])
          tabRefs.current[next]?.focus()
        }}>{item}</button>)}
      </div>
      <div className="agent-panel-content">
        <section id="agent-pane-details" role="tabpanel" aria-labelledby="agent-tab-details" hidden={tab !== 'Details'} tabIndex={0}>
          <p className="routines-description">Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.</p>
          <h3 className="voice-heading">Voice chat</h3>
          <div className="voice-settings">
            <div className="voice-setting"><label id="agent-voice-label" htmlFor="agent-voice">Voice</label><SelectMenu id="agent-voice" labelledBy="agent-voice-label" variant="panel" value={voice} onChange={setVoice} options={['Helix', 'Nova', 'Echo']} /></div>
            <div className="voice-setting"><label id="agent-speed-label" htmlFor="agent-speed">Speed</label><SelectMenu id="agent-speed" labelledBy="agent-speed-label" variant="panel" value={speed} onChange={setSpeed} options={['0.75x', '1x', '1.25x', '1.5x']} /></div>
            <div className="voice-setting"><label id="agent-language-label" htmlFor="agent-language">Language</label><SelectMenu id="agent-language" labelledBy="agent-language-label" variant="panel" value={language} onChange={setLanguage} options={['Auto-detect', 'English', 'Indonesian']} /></div>
          </div>
          <p className="panel-demo-note">Preview settings only. Voice chat and routines are not connected yet.</p>
        </section>
        <section id="agent-pane-library" role="tabpanel" aria-labelledby="agent-tab-library" hidden={tab !== 'Library'} tabIndex={0}>
          <h3 className="panel-section-heading">Conversation files</h3>
          {files.length ? <ul className="panel-file-list">{files.map((file, index) => <li key={`${file}-${index}`}><FileText size={18} aria-hidden="true" /><span>{file}</span></li>)}</ul> : <div className="panel-empty"><FileText size={26} aria-hidden="true" /><p>No files yet</p><span>Attach a file in chat to see its name here. Files stay on your device in this demo.</span></div>}
        </section>
        <section id="agent-pane-computer" role="tabpanel" aria-labelledby="agent-tab-computer" hidden={tab !== 'Computer'} tabIndex={0}>
          <div className="panel-empty"><Monitor size={28} aria-hidden="true" /><p>No computer connected</p><span>This template has no device access. A computer integration can be added later.</span></div>
        </section>
      </div>
    </aside>
  </div>
}
