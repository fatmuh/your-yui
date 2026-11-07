import { useEffect, useState, type KeyboardEvent } from 'react'
import { ChartColumn, Check, Copy, Download, Monitor, Settings, Shield, Vault, X } from 'lucide-react'
import { SelectMenu } from './SelectMenu'
import { useAnimatedDialog } from './useAnimatedDialog'
import './settings.css'

const pages = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'computer', label: 'Computer', icon: Monitor },
  { id: 'permissions', label: 'Permissions', icon: Shield },
  { id: 'vault', label: 'Vault', icon: Vault },
  { id: 'billing', label: 'Usage & Billing', icon: ChartColumn },
  { id: 'updates', label: 'Updates', icon: Download },
] as const
type Page = typeof pages[number]['id']

const localPages: Record<Exclude<Page, 'general'>, string> = {
  computer: 'Computer is not connected. This page does not control a machine, and files stay in this chat.',
  permissions: 'Permissions are not connected. This page does not grant access to apps or accounts.',
  vault: 'Vault is not connected. Nothing here is stored outside this browser, and chats reset when you reload.',
  billing: 'Usage and billing are not connected. The 8% used label in the workspace menu is sample data, and this page cannot charge you.',
  updates: 'Updates are not connected. This page does not download or install software.',
}

const email = 'fathur@moccilabs.com'

type Props = { open: boolean; onClose: () => void; spellCheck: boolean; onSpellCheck: (value: boolean) => void }

export function SettingsDialog({ open, onClose, spellCheck, onSpellCheck }: Props) {
  const { dialogRef, close } = useAnimatedDialog(open, onClose)
  const [page, setPage] = useState<Page>('general')
  const [theme, setTheme] = useState('Follow System')
  const [accent, setAccent] = useState('Bot color')
  const [language, setLanguage] = useState('Follow System')
  const [status, setStatus] = useState('')
  const [copied, setCopied] = useState(false)
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 720px)').matches)
  const current = pages.find(item => item.id === page) ?? pages[0]

  useEffect(() => {
    const media = matchMedia('(max-width: 720px)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!open) return
    setPage('general')
    setStatus('')
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>('[data-page="general"]')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, dialogRef])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!status) return
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    document.getElementById('settings-status')?.scrollIntoView({ block: 'nearest', behavior })
  }, [status])

  function selectPage(next: Page) {
    setPage(next)
    setStatus('')
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const index = Math.max(0, tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'))
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    selectPage(tabs[next].dataset.page as Page)
    tabs[next].focus({ preventScroll: true })
  }

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(email)
      setCopied(true)
      setStatus('Email copied.')
    } catch {
      setCopied(false)
      setStatus('Unable to copy. Clipboard access is blocked by your browser.')
    }
  }

  return <dialog ref={dialogRef} className="settings-dialog t-modal" aria-labelledby="settings-title" aria-describedby="settings-demo" onCancel={event => { event.preventDefault(); void close() }} onClick={event => {
    if (event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void close()
  }}>
    <p id="settings-demo" className="sr-only">Local demo. Nothing here starts a subscription, adds an account, or signs you out. Chats stay in this browser.</p>
    <button type="button" className="settings-close" aria-label="Close settings" onClick={() => void close()}><X size={16} strokeWidth={1.75} /></button>
    <div className="settings-layout">
      <div className="settings-nav" role="tablist" aria-orientation={narrow ? 'horizontal' : 'vertical'} aria-label="Settings" onKeyDown={onTabKeyDown}>
        {pages.map(item => {
          const Icon = item.icon
          const selected = page === item.id
          return <button key={item.id} type="button" className="settings-tab" role="tab" id={`settings-tab-${item.id}`} data-page={item.id} aria-selected={selected} aria-controls="settings-panel" tabIndex={selected ? 0 : -1} onClick={() => selectPage(item.id)}>
            <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        })}
      </div>
      <div className="settings-main">
        <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${page}`} tabIndex={page === 'general' ? undefined : 0} className="settings-scroll">
          <h2 id="settings-title">{current.label}</h2>
          <p id="settings-status" role="status" className={status ? 'settings-status' : 'sr-only'}>{status}</p>
          {page === 'general' ? <GeneralPage theme={theme} accent={accent} language={language} spellCheck={spellCheck} copied={copied} onTheme={setTheme} onAccent={setAccent} onLanguage={setLanguage} onSpellCheck={onSpellCheck} onCopy={() => void copyEmail()} onStarted={() => setStatus('Subscriptions are not connected. Get started does not start a purchase.')} onAccount={() => setStatus('Adding an account is not connected. This demo keeps one local workspace.')} onSignOut={() => setStatus('Log out is not connected. This local chat stays open.')} /> : <p className="settings-note">{localPages[page]}</p>}
        </div>
      </div>
    </div>
  </dialog>
}

function GeneralPage({ theme, accent, language, spellCheck, copied, onTheme, onAccent, onLanguage, onSpellCheck, onCopy, onStarted, onAccount, onSignOut }: {
  theme: string
  accent: string
  language: string
  spellCheck: boolean
  copied: boolean
  onTheme: (value: string) => void
  onAccent: (value: string) => void
  onLanguage: (value: string) => void
  onSpellCheck: (value: boolean) => void
  onCopy: () => void
  onStarted: () => void
  onAccount: () => void
  onSignOut: () => void
}) {
  return <>
    <section className="settings-promo" aria-labelledby="settings-promo-title">
      <div className="settings-promo-copy">
        <h3 id="settings-promo-title">Unlock the ultimate AI subscription</h3>
        <p>Get Yui on every device – with more access and benefits than before. We’ll combine any existing workspaces for you.</p>
        <button type="button" className="settings-cta" aria-describedby="settings-cta-note" onClick={onStarted}>Get started</button>
        <span id="settings-cta-note" className="sr-only">Does not start a purchase. This is a local preview.</span>
      </div>
      <div className="settings-promo-marks" aria-hidden="true">
        <svg viewBox="0 0 32 32" className="settings-mark"><path d="M16 4.5 27.5 11v10L16 27.5 4.5 21V11Z" /><path d="M16 16 27.5 11M16 16 4.5 11M16 16v11.5" /></svg>
        <svg viewBox="0 0 32 32" className="settings-mark"><path d="M22.5 8.5c3.4 2.4 4.4 7.6 1.5 11.2-3 3.8-8.6 4.4-12 1.6-2.8-2.3-3.4-6.4-.7-9.1 2-2.1 5.4-2.3 7.2-.5 1.3 1.3 1 3.2-.6 3.8" /></svg>
        <svg viewBox="0 0 32 32" className="settings-mark settings-mark-dot"><circle cx="16" cy="16" r="6.2" /></svg>
        <svg viewBox="0 0 32 32" className="settings-mark settings-mark-x"><path d="M8.5 8.5 23.5 23.5M23.5 8.5 8.5 23.5" /></svg>
      </div>
    </section>
    <h3 className="settings-section">Account</h3>
    <section className="settings-card settings-account" aria-label="Account">
      <span className="settings-avatar" aria-hidden="true"><svg viewBox="0 0 32 24"><path d="M2 11h7v7H2zm8-5h7v7h-7zm8 0h5l7 7v5h-7v-7h-5zM10 13h7v5h-7z" /></svg></span>
      <div className="settings-identity">
        <p className="settings-name">Fathur Muhammad</p>
        <p className="settings-email"><bdi>{email}</bdi><button type="button" className="settings-copy" aria-label="Copy email address" onClick={onCopy}>{copied ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}</button></p>
      </div>
      <div className="settings-account-actions">
        <button type="button" className="settings-pill" aria-describedby="settings-account-note" onClick={onAccount}>Add account</button>
        <span id="settings-account-note" className="sr-only">Does not add an account. This demo keeps one local workspace.</span>
        <button type="button" className="settings-pill" aria-describedby="settings-signout-note" onClick={onSignOut}>Sign Out</button>
        <span id="settings-signout-note" className="sr-only">Does not sign you out. This local chat stays open.</span>
      </div>
    </section>
    <h3 className="settings-section">Appearance</h3>
    <section className="settings-card settings-appearance" aria-label="Appearance">
      <SelectRow label="Theme" value={theme} options={['Follow System', 'Dark', 'Light']} onChange={onTheme} />
      <SelectRow label="Accent" value={accent} options={['Bot color', 'White', 'Green', 'Blue', 'Pink']} onChange={onAccent} />
      <SelectRow label="Language" value={language} options={['Follow System', 'English', 'Bahasa Indonesia']} onChange={onLanguage} />
      <label className="settings-row">
        <span>Check Spelling While Typing</span>
        <span className="settings-switch">
          <input type="checkbox" role="switch" checked={spellCheck} onChange={event => onSpellCheck(event.target.checked)} />
          <span aria-hidden="true" />
        </span>
      </label>
    </section>
  </>
}

function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  const id = `settings-${label.toLowerCase().replace(/\s+/g, '-')}`
  return <div className="settings-row">
    <label id={`${id}-label`} htmlFor={id}>{label}</label>
    <SelectMenu id={id} labelledBy={`${id}-label`} variant="settings" value={value} options={options} onChange={onChange} />
  </div>
}
