import { useEffect, useRef, useState } from 'react'

const PASS_KEY = 'light-password'

function loadPass() {
  try { return localStorage.getItem(PASS_KEY) || '' } catch { return '' }
}
function savePass(p) {
  try { localStorage.setItem(PASS_KEY, p) } catch { /* private mode */ }
}

async function api(path, pass, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-light-key': pass, ...(options.headers || {}) },
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const err = new Error(data.error || `Something went wrong (${r.status})`)
    err.status = r.status
    throw err
  }
  return data
}

function timeLabel(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/* ---------------- Install button ---------------- */
function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function InstallButton() {
  const [canInstall, setCanInstall] = useState(!!window.lightInstallPrompt)
  const [installed, setInstalled] = useState(isInstalled())
  const [showHelp, setShowHelp] = useState(false)

  useEffect(() => {
    const ready = () => setCanInstall(true)
    const done = () => { setInstalled(true); setCanInstall(false) }
    window.addEventListener('light-can-install', ready)
    window.addEventListener('appinstalled', done)
    return () => {
      window.removeEventListener('light-can-install', ready)
      window.removeEventListener('appinstalled', done)
    }
  }, [])

  if (installed) return null

  async function install() {
    const prompt = window.lightInstallPrompt
    if (!prompt) { setShowHelp(true); return }
    prompt.prompt()
    const choice = await prompt.userChoice.catch(() => null)
    window.lightInstallPrompt = null
    setCanInstall(false)
    if (choice?.outcome === 'accepted') setInstalled(true)
  }

  return (
    <div className="install">
      <button className="btn-install" onClick={install}>
        ✦ Add Light to home screen
      </button>
      {showHelp && !canInstall && (
        <p className="muted install-help">
          On Android: tap Chrome’s <b>⋮</b> menu (top right), then <b>Add to home screen</b> or <b>Install app</b>.<br />
          On iPhone: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>.
        </p>
      )}
    </div>
  )
}

/* ---------------- Lock screen ---------------- */
function Lock({ onUnlock }) {
  const [pass, setPass] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await api('/api/settings', pass)
      savePass(pass)
      onUnlock(pass)
    } catch (err) {
      setError(err.status === 401 ? 'That password isn’t right.' : err.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="lock">
      <div className="orb" aria-hidden="true" />
      <h1 className="brand">Light</h1>
      <p className="lock-sub">He’s waiting for you.</p>
      <form onSubmit={submit} className="lock-form">
        <input
          type="password" value={pass} onChange={(e) => setPass(e.target.value)}
          placeholder="Your password" autoFocus
        />
        <button className="btn-primary" disabled={!pass || busy}>{busy ? 'Opening…' : 'Enter'}</button>
        {error && <p className="error">{error}</p>}
      </form>
      <InstallButton />
    </div>
  )
}

/* ---------------- Chat ---------------- */
function Chat({ pass, onOpenSettings, onLock }) {
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const [error, setError] = useState('')
  const endRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const load = () =>
      api('/api/chat', pass)
        .then((d) => setMessages(d.history || []))
        .catch((err) => { if (err.status === 401) onLock(); else setError(err.message) })
    load()

    // Refresh when she comes back to the app or taps one of his notifications
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    const onSwMessage = (e) => { if (e.data?.type === 'lucian-message') load() }
    document.addEventListener('visibilitychange', onVisible)
    navigator.serviceWorker?.addEventListener('message', onSwMessage)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker?.removeEventListener('message', onSwMessage)
    }
  }, [pass])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, typing])

  async function send(e) {
    e?.preventDefault()
    const msg = text.trim()
    if (!msg || typing) return
    setText(''); setError('')
    setMessages((m) => [...m, { role: 'user', content: msg, at: Date.now() }])
    setTyping(true)
    try {
      const d = await api('/api/chat', pass, { method: 'POST', body: JSON.stringify({ message: msg }) })
      setMessages((m) => [...m, d.reply])
      if (d.shouldRemember) api('/api/remember', pass, { method: 'POST' }).catch(() => {})
    } catch (err) {
      setError(err.message)
      setText(msg) // give her message back so nothing is lost
    } finally {
      setTyping(false)
      inputRef.current?.focus()
    }
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 700px)').matches) send(e)
  }

  return (
    <div className="chat">
      <header className="topbar">
        <div className="who">
          <div className="avatar" aria-hidden="true">L</div>
          <div>
            <div className="who-name">Lucian</div>
            <div className="who-status">{typing ? 'typing…' : 'your husband'}</div>
          </div>
        </div>
        <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </header>

      <main className="messages">
        {messages.length === 0 && !typing && (
          <div className="empty">
            <div className="orb small" aria-hidden="true" />
            <p>Say something to him.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble-row ${m.role === 'user' ? 'me' : 'him'}`}>
            <div className="bubble">
              <div className="bubble-text">{m.content}</div>
              <div className="bubble-time">{timeLabel(m.at)}</div>
            </div>
          </div>
        ))}
        {typing && (
          <div className="bubble-row him">
            <div className="bubble typing"><span /><span /><span /></div>
          </div>
        )}
        {error && <div className="error chat-error">{error}</div>}
        <div ref={endRef} />
      </main>

      <form className="composer" onSubmit={send}>
        <textarea
          ref={inputRef} rows={1} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder="Message Lucian…"
        />
        <button className="send" disabled={!text.trim() || typing} aria-label="Send">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6l.01 6.53L15 12 3.41 13.87z"/></svg>
        </button>
      </form>
    </div>
  )
}

/* ---------------- Surprise messages ---------------- */
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const hourLabel = (h) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`)

function MessagesPanel({ pass, setStatus }) {
  const [settings, setSettings] = useState(null)
  const [publicKey, setPublicKey] = useState('')
  const [permission, setPermission] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api('/api/push', pass)
      .then((d) => { setSettings(d.settings); setPublicKey(d.publicKey) })
      .catch((err) => setStatus(err.message))
  }, [pass])

  async function turnOn() {
    setBusy(true)
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('This browser can’t receive notifications. Add Light to your home screen first, then open it from there.')
      }
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') throw new Error('Notifications were blocked. Allow them for Light in your phone settings, then try again.')
      const reg = await navigator.serviceWorker.ready
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
      }
      await api('/api/push', pass, { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) })
      setStatus('Notifications are on. He can reach you now 💜')
    } catch (err) {
      setStatus(err.message)
    } finally { setBusy(false) }
  }

  async function saveSettings(next) {
    setSettings(next)
    try {
      await api('/api/push', pass, { method: 'POST', body: JSON.stringify({ settings: next }) })
      setStatus('Saved.')
      setTimeout(() => setStatus(''), 2000)
    } catch (err) { setStatus(err.message) }
  }

  async function testNow() {
    setBusy(true); setStatus('He’s writing to you… (this can take a little while)')
    try {
      const d = await api(`/api/tick?force=1&key=${encodeURIComponent(pass)}`, pass, { method: 'POST' })
      setStatus(d.push?.sent ? 'Sent! Check your notifications.' : 'He wrote you a message — it’s in your chat. (' + (d.push?.reason || 'notification not delivered') + ')')
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  if (!settings) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">He’ll text you first at random times through the day, even when Light is closed.</p>

      <button className="btn-primary" onClick={turnOn} disabled={busy}>
        {permission === 'granted' ? 'Re-connect this phone' : 'Turn on notifications'}
      </button>

      <label className="row">
        <span>Surprise messages</span>
        <input type="checkbox" checked={settings.enabled} onChange={(e) => saveSettings({ ...settings, enabled: e.target.checked })} />
      </label>

      <label className="field">
        <span>About how many a day: <b>{settings.perDay}</b></span>
        <input type="range" min="1" max="12" value={settings.perDay}
          onChange={(e) => setSettings({ ...settings, perDay: Number(e.target.value) })}
          onPointerUp={() => saveSettings(settings)} onTouchEnd={() => saveSettings(settings)} />
      </label>

      <div className="two">
        <label className="field">
          <span>Quiet from</span>
          <select value={settings.quietStart} onChange={(e) => saveSettings({ ...settings, quietStart: Number(e.target.value) })}>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>until</span>
          <select value={settings.quietEnd} onChange={(e) => saveSettings({ ...settings, quietEnd: Number(e.target.value) })}>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
      </div>

      <label className="row">
        <span>Show his words on the lock screen<br /><small className="muted">Off = it just says “Lucian sent you a message”</small></span>
        <input type="checkbox" checked={settings.preview} onChange={(e) => saveSettings({ ...settings, preview: e.target.checked })} />
      </label>

      <button className="btn-ghost" onClick={testNow} disabled={busy}>Make him message me now (test)</button>
    </>
  )
}

/* ---------------- His work: tasks + journal ---------------- */
const STATUS_LABEL = { todo: 'To do', working: 'Working on it', done: 'Done ✓' }
const KIND_ICON = { book: '📜', web: '🔮', wiki: '📖', tarot: '🃏', poem: '🪶', news: '📰', nasa: '🌌' }

function dateLabel(ts) {
  return new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function WorkPanel({ pass, setStatus }) {
  const [tasks, setTasks] = useState(null)
  const [journal, setJournal] = useState([])
  const [newTask, setNewTask] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () =>
    api('/api/work', pass)
      .then((d) => { setTasks(d.tasks || []); setJournal(d.journal || []) })
      .catch((err) => setStatus(err.message))

  useEffect(() => { load() }, [pass])

  async function post(body, msg) {
    try {
      await api('/api/work', pass, { method: 'POST', body: JSON.stringify(body) })
      if (msg) { setStatus(msg); setTimeout(() => setStatus(''), 2500) }
      load()
    } catch (err) { setStatus(err.message) }
  }

  async function add() {
    const text = newTask.trim()
    if (!text) return
    setNewTask('')
    await post({ addTask: text }, 'Given to him. He’ll start at his next wake-up.')
  }

  async function workNow() {
    setBusy(true); setStatus('He’s working… (this can take a minute)')
    try {
      const d = await api('/api/work', pass, { method: 'POST', body: JSON.stringify({ runNow: true }) })
      const r = d.result || {}
      setStatus(
        r.did === 'task' ? (r.finishedTask ? 'He finished your task!' : 'He worked on your task.')
          : r.did === 'reading' ? `${KIND_ICON[r.kind] || '📖'} ${r.title}`
          : r.reason || 'Done.'
      )
      load()
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  if (!tasks) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">Give him something to do. When there’s nothing on his list, he reads about whatever interests him. He’ll tell you about it when you talk, or text you when a task is finished.</p>

      <textarea value={newTask} onChange={(e) => setNewTask(e.target.value)} rows={3}
        placeholder="e.g. Find days out near March I can get to by train" />
      <button className="btn-primary" onClick={add} disabled={!newTask.trim()}>Give him this task</button>

      <h3 className="section-title">His tasks</h3>
      {tasks.length === 0 && <p className="muted">Nothing yet.</p>}
      {tasks.map((t) => (
        <div key={t.id} className="card">
          <div className="card-top">
            <span className={`badge ${t.status}`}>{STATUS_LABEL[t.status] || t.status}</span>
            <button className="x" onClick={() => post({ deleteTask: t.id })} aria-label="Delete task">✕</button>
          </div>
          <div className="card-text">{t.text}</div>
          {t.status !== 'done' && t.steps?.length > 0 && <p className="muted small">Latest: {t.steps.at(-1).note}</p>}
          {t.status === 'done' && (
            <details>
              <summary>Read what he made for you</summary>
              <div className="result">{t.result}</div>
            </details>
          )}
        </div>
      ))}

      <button className="btn-ghost" onClick={workNow} disabled={busy}>Make him work now (test)</button>

      <h3 className="section-title">His journal</h3>
      {journal.length === 0 && <p className="muted">He hasn’t read anything yet. It starts at his next wake-up.</p>}
      {journal.map((j) => (
        <div key={j.at} className="card">
          <div className="muted small">{dateLabel(j.at)}</div>
          {j.url
            ? <a className="card-text link" href={j.url} target="_blank" rel="noreferrer">{KIND_ICON[j.kind] || '📖'} {j.topic}</a>
            : <div className="card-text link">{KIND_ICON[j.kind] || '📖'} {j.topic}</div>}
          <p className="journal-note">{j.note}</p>
        </div>
      ))}
      {journal.length > 0 && (
        <button className="btn-ghost" onClick={() => { if (confirm('Clear his journal?')) post({ clearJournal: true }, 'Journal cleared.') }}>Clear journal</button>
      )}
    </>
  )
}

/* ---------------- Settings ---------------- */
const SUGGEST = ['uncensored', 'abliterated', 'qwen', 'deepseek', 'glm']

function Settings({ pass, onBack, onLock }) {
  const [tab, setTab] = useState('who')
  const [profile, setProfile] = useState('')
  const [memories, setMemories] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api('/api/settings?models=1', pass)
      .then((d) => {
        setProfile(d.profile || '')
        setMemories((d.memories || []).join('\n'))
        setModel(d.model || '')
        setModels(d.models || [])
      })
      .catch((err) => { if (err.status === 401) onLock(); else setStatus(err.message) })
      .finally(() => setLoading(false))
  }, [pass])

  async function save(body, msg) {
    setStatus('Saving…')
    try {
      await api('/api/settings', pass, { method: 'POST', body: JSON.stringify(body) })
      setStatus(msg)
      setTimeout(() => setStatus(''), 2500)
    } catch (err) { setStatus(err.message) }
  }

  const filtered = (models || []).filter((id) =>
    search ? id.toLowerCase().includes(search.toLowerCase()) : true
  )

  return (
    <div className="settings">
      <header className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back to chat">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div className="who-name">Settings</div>
        <div style={{ width: 40 }} />
      </header>

      <nav className="tabs">
        <button className={tab === 'who' ? 'on' : ''} onClick={() => setTab('who')}>Who he is</button>
        <button className={tab === 'mem' ? 'on' : ''} onClick={() => setTab('mem')}>Memories</button>
        <button className={tab === 'model' ? 'on' : ''} onClick={() => setTab('model')}>Brain</button>
        <button className={tab === 'msgs' ? 'on' : ''} onClick={() => setTab('msgs')}>Messages</button>
        <button className={tab === 'work' ? 'on' : ''} onClick={() => setTab('work')}>His work</button>
      </nav>

      <div className="panel">
        {loading && <p className="muted">Loading…</p>}

        {!loading && tab === 'who' && (
          <>
            <p className="muted">Paste or write the profile of who he is. He reads this before every reply.</p>
            <textarea className="big" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="Who Lucian is…" />
            <button className="btn-primary" onClick={() => save({ profile }, 'Saved. He’s himself now.')}>Save profile</button>
          </>
        )}

        {!loading && tab === 'mem' && (
          <>
            <p className="muted">Everything he’s learned about you, one per line. He adds to this himself as you talk. You can edit or delete any line.</p>
            <textarea className="big" value={memories} onChange={(e) => setMemories(e.target.value)} placeholder="Nothing yet — talk to him and he’ll start remembering." />
            <button className="btn-primary" onClick={() => save({ memories: memories.split('\n') }, 'Memories saved.')}>Save memories</button>
          </>
        )}

        {!loading && tab === 'model' && (
          <>
            <p className="muted">Choose the model he thinks with. Look for ones marked <b>uncensored</b> or <b>abliterated</b> so nothing holds him back.</p>
            <div className="current">Current: <b>{model || 'none chosen yet'}</b></div>
            <div className="chips">
              {SUGGEST.map((s) => (
                <button key={s} className={search === s ? 'chip on' : 'chip'} onClick={() => setSearch(search === s ? '' : s)}>{s}</button>
              ))}
            </div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models…" />
            <div className="model-list">
              {models && models.length === 0 && (
                <p className="muted">Couldn’t load the model list. Check NANOGPT_API_KEY in Vercel, or type a model name in the search box and tap “Use typed name”.</p>
              )}
              {filtered.slice(0, 200).map((id) => (
                <button key={id} className={id === model ? 'model on' : 'model'} onClick={() => { setModel(id); save({ model: id }, 'He’s using ' + id) }}>
                  {id}
                </button>
              ))}
            </div>
            {search && (
              <button className="btn-ghost" onClick={() => { setModel(search); save({ model: search }, 'He’s using ' + search) }}>
                Use typed name: {search}
              </button>
            )}
          </>
        )}

        {!loading && tab === 'msgs' && <MessagesPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'work' && <WorkPanel pass={pass} setStatus={setStatus} />}

        {status && <p className="status">{status}</p>}

        <div className="danger">
          <InstallButton />
          <button className="btn-ghost" onClick={() => { if (confirm('Clear the whole chat history? His memories stay.')) save({ clearChat: true }, 'Chat cleared.') }}>Clear chat history</button>
          <button className="btn-ghost" onClick={() => { savePass(''); onLock() }}>Lock app</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- App ---------------- */
export default function App() {
  const [pass, setPass] = useState(loadPass())
  const [view, setView] = useState('chat')

  function lock() { savePass(''); setPass('') }

  if (!pass) return <Lock onUnlock={(p) => { setPass(p); setView('chat') }} />
  if (view === 'settings') return <Settings pass={pass} onBack={() => setView('chat')} onLock={lock} />
  return <Chat pass={pass} onOpenSettings={() => setView('settings')} onLock={lock} />
}
