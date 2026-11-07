import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Cloud, Code2, Dog, Figma, Github, KeyRound, Mail, Search, Shield, Triangle, Video, X, Zap } from 'lucide-react'
import { useAnimatedDialog } from './useAnimatedDialog'

const categories = ['Password Managers', 'Productivity', 'Communication', 'Design', 'Code', 'Analytics', 'Storage'] as const
type Category = typeof categories[number]
type AppEntry = { id: string; name: string; category: Category; mark: string; color?: string; recommended?: boolean }
const apps: AppEntry[] = [
  { id: 'datadog', name: 'Datadog', category: 'Analytics', mark: 'dog', color: '#7040bc', recommended: true },
  { id: 'vercel', name: 'Vercel', category: 'Code', mark: 'vercel', recommended: true },
  { id: 'supabase', name: 'Supabase', category: 'Code', mark: 'supabase', recommended: true },
  { id: 'github', name: 'GitHub', category: 'Code', mark: 'github', color: '#252b32', recommended: true },
  { id: 'cloudflare', name: 'Cloudflare', category: 'Code', mark: 'cloud', color: '#f58220', recommended: true },
  { id: 'sentry', name: 'Sentry', category: 'Code', mark: 'sentry', recommended: true },
  { id: '1password', name: '1Password', category: 'Password Managers', mark: 'key', color: '#34373d' },
  { id: 'notion', name: 'Notion', category: 'Productivity', mark: 'N' },
  { id: 'linear', name: 'Linear', category: 'Productivity', mark: 'L', color: '#5e6ad2' },
  { id: 'todoist', name: 'Todoist', category: 'Productivity', mark: '✓', color: '#d83b34' },
  { id: 'asana', name: 'Asana', category: 'Productivity', mark: '•••', color: '#b83154' },
  { id: 'email', name: 'Email', category: 'Communication', mark: 'mail', color: '#c72280' },
  { id: 'gmail', name: 'Gmail', category: 'Communication', mark: 'gmail' },
  { id: 'calendar', name: 'Google Calendar', category: 'Communication', mark: 'calendar' },
  { id: 'outlook', name: 'Outlook', category: 'Communication', mark: 'O', color: '#0878bd' },
  { id: 'x', name: 'X', category: 'Communication', mark: '𝕏', color: '#080808' },
  { id: 'slack', name: 'Slack', category: 'Communication', mark: 'slack' },
  { id: 'outlook-calendar', name: 'Outlook Calendar', category: 'Communication', mark: 'calendar', color: '#0878bd' },
  { id: 'agentmail', name: 'AgentMail', category: 'Communication', mark: 'shield' },
  { id: 'postiz', name: 'postiz', category: 'Communication', mark: 'P', color: '#6532c4' },
  { id: 'calendly', name: 'Calendly', category: 'Communication', mark: 'C', color: '#357bd0' },
  { id: 'zoom', name: 'Zoom', category: 'Communication', mark: 'video', color: '#0866ff' },
  { id: 'inkbox', name: 'Inkbox', category: 'Communication', mark: 'I', color: '#353535' },
  { id: 'figma', name: 'Figma', category: 'Design', mark: 'figma' },
  { id: 'canva', name: 'Canva', category: 'Design', mark: 'C', color: '#087f8c' },
  { id: 'drive', name: 'Google Drive', category: 'Storage', mark: 'drive' },
  { id: 'dropbox', name: 'Dropbox', category: 'Storage', mark: '◇', color: '#0866ff' },
]
function AppMark({ app }: { app: AppEntry }) {
  const icons = { dog: Dog, github: Github, cloud: Cloud, key: KeyRound, mail: Mail, shield: Shield, video: Video, figma: Figma, sentry: Triangle }
  const Icon = icons[app.mark as keyof typeof icons]
  return <span className={`catalog-mark catalog-mark--${app.mark}`} style={app.color ? { backgroundColor: app.color } : undefined} aria-hidden="true">
    {Icon ? <Icon size={25} strokeWidth={1.8} /> : app.mark === 'vercel' ? <svg viewBox="0 0 32 32"><path d="M16 4 31 29H1Z" fill="currentColor" /></svg> : app.mark === 'supabase' ? <Zap size={30} fill="currentColor" strokeWidth={1} /> : app.mark === 'gmail' ? <svg viewBox="0 0 32 28" fill="none" strokeWidth="6"><path d="M4 25V5l12 9L28 5v20" stroke="#4285f4" /><path d="M4 25V5l12 9L28 5v20" stroke="#34a853" strokeDasharray="0 52 20" /><path d="m4 5 12 9L28 5" stroke="#ea4335" /></svg> : app.mark === 'calendar' ? <span className="catalog-calendar">31</span> : app.mark === 'slack' ? <svg viewBox="0 0 32 32" strokeWidth="6" strokeLinecap="round"><path d="M12 3v10M3 12h4" stroke="#36c5f0" /><path d="M19 3h4M20 12h9" stroke="#2eb67d" /><path d="M29 20h-9M20 29v-3" stroke="#ecb22e" /><path d="M12 20v9M3 20h3" stroke="#e01e5a" /></svg> : app.mark === 'drive' ? <svg viewBox="0 0 32 30"><path d="m11 2 10 0 11 19H22Z" fill="#fbbc04" /><path d="M11 2 0 21l5 8 11-19Z" fill="#34a853" /><path d="M0 21h32l-5 8H5Z" fill="#4285f4" /></svg> : app.mark}
  </span>
}

type Props = { open: boolean; onClose: () => void }
export function ConnectAppsDialog({ open, onClose }: Props) {
  const { dialogRef, close } = useAnimatedDialog(open, onClose)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('All')
  const [connected, setConnected] = useState<string[]>([])
  const [more, setMore] = useState(false)
  const [templates, setTemplates] = useState(false)
  const [status, setStatus] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (open) { setQuery(''); setCategory('All'); setMore(false); setTemplates(false); setStatus('') } }, [open])
  function filter(next: string) { setCategory(next); setTemplates(false); scrollRef.current?.scrollTo({ top: 0 }) }
  const matching = apps.filter(app => app.name.toLowerCase().includes(query.trim().toLowerCase()) && (category === 'All' || (category === 'Connected' ? connected.includes(app.id) : category === 'Recommended for you' ? app.recommended : app.category === category)))
  const sections = category === 'All' && !query.trim() ? ['Recommended for you', ...categories] : [category === 'All' ? 'Search results' : category === 'Connected' ? 'Connected apps · Demo' : category]
  return <dialog ref={dialogRef} className="connect-apps-dialog t-modal" aria-labelledby="connect-apps-title" aria-describedby="connect-apps-demo" onCancel={event => { event.preventDefault(); void close() }} onClick={event => {
    if (event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void close()
  }}>
    <button type="button" className="catalog-close" aria-label="Close Connect Apps" onClick={() => void close()}><X size={21} /></button>
    <div ref={scrollRef} className="catalog-scroll">
      <header className="catalog-header"><h2 id="connect-apps-title">Connect Apps</h2><button type="button" className="catalog-connected" aria-pressed={category === 'Connected'} onClick={() => filter(category === 'Connected' ? 'All' : 'Connected')}><span className="catalog-connected-marks" aria-hidden="true">{connected.slice(0, 2).map(id => <AppMark key={id} app={apps.find(app => app.id === id)!} />)}</span><span>{connected.length} connected</span><ChevronRight size={17} /></button></header>
      <div className="catalog-tools"><label className="catalog-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Search across apps and skills</span><input name="app-search" autoComplete="off" placeholder="Search across apps and skills" value={query} onChange={event => { setQuery(event.target.value); setTemplates(false) }} /></label><button type="button" className="catalog-templates" aria-pressed={templates} onClick={() => setTemplates(value => !value)}><span className="catalog-bot-mark" aria-hidden="true">●</span>Bot templates<ArrowUpRight size={16} /></button></div>
      <div className="catalog-filters" role="group" aria-label="App categories">{['All', ...categories.slice(0, 5)].map(item => <button type="button" key={item} aria-pressed={category === item && !templates} onClick={() => filter(item)}>{item}</button>)}<button type="button" aria-expanded={more} aria-controls="catalog-more" onClick={() => setMore(value => !value)}>More<ChevronDown size={14} /></button></div>
      {more && <div id="catalog-more" className="catalog-more" role="group" aria-label="More app categories">{categories.slice(5).map(item => <button type="button" key={item} aria-pressed={category === item} onClick={() => filter(item)}>{item}</button>)}</div>}
      <p id="connect-apps-demo" className="catalog-demo">Demo catalog · Connections are local previews. No accounts are accessed.</p>
      <div className="sr-only" role="status">{status || `${matching.length} apps available`}</div>
      {templates ? <section className="catalog-template-page"><Code2 size={30} aria-hidden="true" /><h3>Bot templates</h3><p>Bot templates are not connected in this demo. Use the + button in the sidebar to create a local bot with your own name and avatar.</p><button type="button" onClick={() => setTemplates(false)}>Back to apps</button></section> : matching.length ? sections.map(section => {
        const entries = section === 'Recommended for you' ? matching.filter(app => app.recommended) : category === 'All' && !query.trim() ? matching.filter(app => app.category === section) : matching
        return entries.length ? <section className="catalog-section" key={section} aria-labelledby={`catalog-${section.replace(/\W/g, '-')}`}><div className="catalog-section-heading"><h3 id={`catalog-${section.replace(/\W/g, '-')}`}>{section}</h3>{category === 'All' && !query.trim() && section !== 'Password Managers' && <button type="button" onClick={() => filter(section)} aria-label={`View all ${section === 'Recommended for you' ? 'recommended apps' : section}`}>View all</button>}</div><div className="catalog-grid">{entries.map(app => <div className="catalog-app" key={app.id}><AppMark app={app} /><span className="catalog-app-name">{app.name}</span><button type="button" className="catalog-connect" aria-label={`${connected.includes(app.id) ? 'Disconnect' : 'Connect'} ${app.name}`} aria-pressed={connected.includes(app.id)} onClick={() => { const added = !connected.includes(app.id); setConnected(current => added ? [...current, app.id] : current.filter(id => id !== app.id)); setStatus(`${app.name} ${added ? 'added to' : 'removed from'} demo connections. No account was accessed.`) }}>{connected.includes(app.id) ? <><Check size={13} aria-hidden="true" />Added</> : 'Connect'}</button></div>)}</div></section> : null
      }) : <div className="catalog-empty"><h3>{category === 'Connected' ? 'No connected apps' : 'No apps found'}</h3><p>{category === 'Connected' ? 'Add a demo connection from the catalog to see it here.' : 'Try another app name or reset your filters.'}</p><button type="button" onClick={() => { setQuery(''); filter('All') }}>Browse all apps</button></div>}
    </div>
  </dialog>
}
