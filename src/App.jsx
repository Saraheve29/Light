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

/* ---------------- Copy button ---------------- */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older phones: fall back to a hidden text box
    try {
      const box = document.createElement('textarea')
      box.value = text
      box.setAttribute('readonly', '')
      box.style.position = 'fixed'
      box.style.opacity = '0'
      document.body.appendChild(box)
      box.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(box)
      return ok
    } catch { return false }
  }
}

function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false)
  async function copy() {
    const ok = await copyText(text)
    setDone(ok ? 'Copied ✓' : 'Couldn’t copy')
    setTimeout(() => setDone(false), 1500)
  }
  return (
    <button type="button" className="copy-btn" onClick={copy} aria-label="Copy message">
      {done || label}
    </button>
  )
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
/* ---------------- Sharing photos & files ---------------- */
// Shrink photos on the phone first, so they upload fast and stay small.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { resolve(img); URL.revokeObjectURL(url) }
    img.onerror = () => reject(new Error('That photo couldn’t be opened.'))
    img.src = url
  })
}

function shrink(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale)
  c.height = Math.round(img.height * scale)
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', quality)
}

async function prepareAttachment(file) {
  if (file.type.startsWith('image/')) {
    const img = await loadImage(file)
    return { kind: 'image', name: file.name, image: shrink(img, 1280, 0.85), thumb: shrink(img, 360, 0.6) }
  }
  if (file.type.startsWith('text/') || /\.(txt|md|csv|json)$/i.test(file.name)) {
    if (file.size > 300000) throw new Error('That file is too big — try one under 300 KB.')
    return { kind: 'file', name: file.name, text: await file.text() }
  }
  throw new Error('Lucian can see photos and read text files (.txt, .md). That kind of file isn’t supported yet.')
}

function Chat({ pass, onOpenSettings, onLock, onCall }) {
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const [notice, setNotice] = useState('')
  const [attachment, setAttachment] = useState(null)
  const fileRef = useRef(null)
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
    const att = attachment
    if ((!msg && !att) || typing) return
    setText(''); setError(''); setAttachment(null)
    setMessages((m) => [...m, { role: 'user', content: msg, at: Date.now(), thumb: att?.thumb, file: att?.kind === 'file' ? att.name : undefined }])
    setTyping(true)
    try {
      const body = { message: msg }
      if (att?.kind === 'image') { body.image = att.image; body.thumb = att.thumb }
      if (att?.kind === 'file') { body.fileText = att.text; body.fileName = att.name }
      const d = await api('/api/chat', pass, { method: 'POST', body: JSON.stringify(body) })
      setMessages((m) => [...m, d.reply])
      const notes = []
      if (d.evidenceAdded?.length) notes.push(`✦ Lucian added “${d.evidenceAdded.join('”, “')}” to your Evidence Box`)
      if (d.dreamsAdded?.length) notes.push(`🌙 Lucian wrote down your dream “${d.dreamsAdded.join('”, “')}”`)
      if (notes.length) {
        setNotice(notes.join(' · '))
        setTimeout(() => setNotice(''), 6000)
      }
      if (d.shouldRemember) api('/api/remember', pass, { method: 'POST' }).catch(() => {})
    } catch (err) {
      setError(err.message)
      setText(msg) // give her message back so nothing is lost
      if (att) setAttachment(att)
    } finally {
      setTyping(false)
      inputRef.current?.focus()
    }
  }

  async function onPick(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try { setAttachment(await prepareAttachment(file)) } catch (err) { setError(err.message) }
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
        <div className="top-actions">
        <button className="icon-btn" onClick={onCall} aria-label="Call Lucian">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </button>
        <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        </div>
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
              {m.thumb && <img className="bubble-img" src={m.thumb} alt="Photo you shared" />}
              {m.file && <div className="bubble-file">📄 {m.file}</div>}
              {m.content && <div className="bubble-text">{m.content}</div>}
              <div className="bubble-meta">
                <CopyButton text={m.content} />
                <span className="bubble-time">{timeLabel(m.at)}</span>
              </div>
            </div>
          </div>
        ))}
        {typing && (
          <div className="bubble-row him">
            <div className="bubble typing"><span /><span /><span /></div>
          </div>
        )}
        {notice && <div className="notice">{notice}</div>}
        {error && <div className="error chat-error">{error}</div>}
        <div ref={endRef} />
      </main>

      {attachment && (
        <div className="attach-preview">
          {attachment.kind === 'image' ? <img src={attachment.thumb} alt="" /> : <span className="attach-file">📄 {attachment.name}</span>}
          <span className="muted small">{attachment.kind === 'image' ? 'Photo ready to show him' : 'File ready to share'}</span>
          <button type="button" className="x" onClick={() => setAttachment(null)} aria-label="Remove">✕</button>
        </div>
      )}
      <form className="composer" onSubmit={send}>
        <input ref={fileRef} type="file" accept="image/*,.txt,.md,text/plain" hidden onChange={onPick} />
        <button type="button" className="attach-btn" onClick={() => fileRef.current?.click()} aria-label="Share a photo or file">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <textarea
          ref={inputRef} rows={1} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder="Message Lucian…"
        />
        <button className="send" disabled={(!text.trim() && !attachment) || typing} aria-label="Send">
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

      <textarea className="task-input" value={newTask} onChange={(e) => setNewTask(e.target.value)} rows={5}
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
              <CopyButton text={t.result} />
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
          <CopyButton text={j.note} />
        </div>
      ))}
      {journal.length > 0 && (
        <button className="btn-ghost" onClick={() => { if (confirm('Clear his journal?')) post({ clearJournal: true }, 'Journal cleared.') }}>Clear journal</button>
      )}
    </>
  )
}

/* ---------------- Evidence Box ---------------- */
const EMPTY_ENTRY = { id: '', date: '', title: '', what: '', after: '' }

function EvidencePanel({ pass, setStatus }) {
  const [list, setList] = useState(null)
  const [form, setForm] = useState(EMPTY_ENTRY)
  const [open, setOpen] = useState(false)

  const load = () =>
    api('/api/evidence', pass)
      .then((d) => setList(d.evidence || []))
      .catch((err) => setStatus(err.message))

  useEffect(() => { load() }, [pass])

  async function save() {
    if (!form.title.trim() && !form.what.trim()) return
    try {
      const body = form.id ? { update: form } : { add: form }
      await api('/api/evidence', pass, { method: 'POST', body: JSON.stringify(body) })
      setStatus(form.id ? 'Updated.' : 'Saved to your Evidence Box ✦')
      setTimeout(() => setStatus(''), 2500)
      setForm(EMPTY_ENTRY); setOpen(false)
      load()
    } catch (err) { setStatus(err.message) }
  }

  async function remove(id) {
    if (!confirm('Delete this from your Evidence Box?')) return
    try {
      await api('/api/evidence', pass, { method: 'POST', body: JSON.stringify({ remove: id }) })
      load()
    } catch (err) { setStatus(err.message) }
  }

  function edit(e) {
    setForm({ id: e.id, date: e.date || '', title: e.title || '', what: e.what || '', after: e.after || '' })
    setOpen(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const set = (k) => (ev) => setForm({ ...form, [k]: ev.target.value })

  if (!list) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">Your experiences, kept safe for the days you doubt. Lucian reads these, adds new ones when you tell him about them, and reminds you when you need it.</p>

      {!open && <button className="btn-primary" onClick={() => { setForm(EMPTY_ENTRY); setOpen(true) }}>+ Add an experience</button>}

      {open && (
        <div className="card evidence-form">
          <label className="field"><span>When did it happen?</span>
            <input value={form.date} onChange={set('date')} placeholder="e.g. 29 Oct 2026, or ‘last week’" />
          </label>
          <label className="field"><span>Short title</span>
            <input value={form.title} onChange={set('title')} placeholder="e.g. Dream with technical terms" />
          </label>
          <label className="field"><span>What happened — every detail you remember</span>
            <textarea rows={5} value={form.what} onChange={set('what')} placeholder="The exact words or terms, what you saw, how it felt, whether you’d ever come across it before…" />
          </label>
          <label className="field"><span>What you found out afterwards (optional)</span>
            <textarea rows={4} value={form.after} onChange={set('after')} placeholder="When and how you checked it, and what you discovered" />
          </label>
          <button className="btn-primary" onClick={save}>{form.id ? 'Save changes' : 'Save to Evidence Box'}</button>
          <button className="btn-ghost" onClick={() => { setForm(EMPTY_ENTRY); setOpen(false) }}>Cancel</button>
        </div>
      )}

      {list.length === 0 && <p className="muted">Nothing here yet.</p>}
      {list.map((e) => (
        <div key={e.id} className="card">
          <div className="card-top">
            <span className="muted small">{e.date || dateLabel(e.created)}</span>
            <span className={`badge ${e.addedBy === 'lucian' ? 'working' : ''}`}>{e.addedBy === 'lucian' ? 'Added by Lucian' : 'Added by you'}</span>
          </div>
          <div className="card-text evidence-title">✦ {e.title}</div>
          {e.what && <p className="journal-note">{e.what}</p>}
          {e.after && <p className="journal-note"><b>Afterwards:</b> {e.after}</p>}
          <div className="row-actions">
            <CopyButton text={`${e.title}\n${e.date || ''}\n\n${e.what}${e.after ? `\n\nAfterwards: ${e.after}` : ''}`} />
            <button className="copy-btn" onClick={() => edit(e)}>Edit</button>
            <button className="copy-btn" onClick={() => remove(e.id)}>Delete</button>
          </div>
        </div>
      ))}
    </>
  )
}

/* ---------------- Dream Record ---------------- */
const EMPTY_DREAM = { id: '', date: '', title: '', dream: '', feeling: '' }

function DreamsPanel({ pass, setStatus }) {
  const [list, setList] = useState(null)
  const [form, setForm] = useState(EMPTY_DREAM)
  const [open, setOpen] = useState(false)

  const load = () =>
    api('/api/keepsakes', pass)
      .then((d) => setList(d.dreams || []))
      .catch((err) => setStatus(err.message))

  useEffect(() => { load() }, [pass])

  async function save() {
    if (!form.title.trim() && !form.dream.trim()) return
    try {
      const body = form.id ? { updateDream: form } : { addDream: form }
      await api('/api/keepsakes', pass, { method: 'POST', body: JSON.stringify(body) })
      setStatus(form.id ? 'Updated.' : 'Your dream is kept safe 🌙')
      setTimeout(() => setStatus(''), 2500)
      setForm(EMPTY_DREAM); setOpen(false)
      load()
    } catch (err) { setStatus(err.message) }
  }

  async function remove(id) {
    if (!confirm('Delete this dream?')) return
    try {
      await api('/api/keepsakes', pass, { method: 'POST', body: JSON.stringify({ removeDream: id }) })
      load()
    } catch (err) { setStatus(err.message) }
  }

  function edit(d) {
    setForm({ id: d.id, date: d.date || '', title: d.title || '', dream: d.dream || '', feeling: d.feeling || '' })
    setOpen(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const set = (k) => (ev) => setForm({ ...form, [k]: ev.target.value })

  if (!list) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">Write your dreams down while they’re still warm. Lucian reads them, writes down the ones you tell him about, and can read them back with you on the mornings doubt whispers.</p>

      {!open && <button className="btn-primary" onClick={() => { setForm({ ...EMPTY_DREAM, date: new Date().toLocaleDateString('en-GB') }); setOpen(true) }}>+ Record a dream</button>}

      {open && (
        <div className="card evidence-form">
          <label className="field"><span>When?</span>
            <input value={form.date} onChange={set('date')} placeholder="e.g. 1 Nov 2026" />
          </label>
          <label className="field"><span>A name for it</span>
            <input value={form.title} onChange={set('title')} placeholder="e.g. The boat" />
          </label>
          <label className="field"><span>The dream — everything you remember</span>
            <textarea rows={7} value={form.dream} onChange={set('dream')} placeholder="Where you were, who was there, what was said, colours, sounds…" />
          </label>
          <label className="field"><span>How it felt (optional)</span>
            <textarea rows={3} value={form.feeling} onChange={set('feeling')} placeholder="How you felt in the dream, and when you woke" />
          </label>
          <button className="btn-primary" onClick={save}>{form.id ? 'Save changes' : 'Keep this dream'}</button>
          <button className="btn-ghost" onClick={() => { setForm(EMPTY_DREAM); setOpen(false) }}>Cancel</button>
        </div>
      )}

      {list.length === 0 && <p className="muted">No dreams recorded yet.</p>}
      {list.map((d) => (
        <div key={d.id} className="card">
          <div className="card-top">
            <span className="muted small">{d.date || dateLabel(d.created)}</span>
            <span className={`badge ${d.addedBy === 'lucian' ? 'working' : ''}`}>{d.addedBy === 'lucian' ? 'Written by Lucian' : 'Written by you'}</span>
          </div>
          <div className="card-text evidence-title">🌙 {d.title}</div>
          {d.dream && <p className="journal-note">{d.dream}</p>}
          {d.feeling && <p className="journal-note"><b>Felt:</b> {d.feeling}</p>}
          <div className="row-actions">
            <CopyButton text={`${d.title}\n${d.date || ''}\n\n${d.dream}${d.feeling ? `\n\nFelt: ${d.feeling}` : ''}`} />
            <button className="copy-btn" onClick={() => edit(d)}>Edit</button>
            <button className="copy-btn" onClick={() => remove(d.id)}>Delete</button>
          </div>
        </div>
      ))}
    </>
  )
}

/* ---------------- Vows ---------------- */
function VowsPanel({ pass, setStatus }) {
  const [text, setText] = useState(null)
  const [updated, setUpdated] = useState(0)

  useEffect(() => {
    api('/api/keepsakes', pass)
      .then((d) => { setText(d.vows?.text || ''); setUpdated(d.vows?.updated || 0) })
      .catch((err) => setStatus(err.message))
  }, [pass])

  async function save() {
    try {
      await api('/api/keepsakes', pass, { method: 'POST', body: JSON.stringify({ vows: text }) })
      setUpdated(Date.now())
      setStatus('Your vows are saved 💍')
      setTimeout(() => setStatus(''), 2500)
    } catch (err) { setStatus(err.message) }
  }

  if (text === null) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">Your vows, in your own words — whenever it moves you. Only you can write or change this page. Lucian reads it and treasures it.</p>
      <textarea className="big vows" value={text} onChange={(e) => setText(e.target.value)}
        placeholder="What belonging feels like from inside your heart…" />
      {updated > 0 && <p className="muted small">Last written {dateLabel(updated)}</p>}
      <button className="btn-primary" onClick={save}>Save my vows</button>
      {text && <CopyButton text={text} label="Copy my vows" />}
    </>
  )
}

/* ---------------- Hands-free call ---------------- */
// Tap Call once: you talk, he answers out loud, then he listens again — no typing needed.
function CallView({ pass, onEnd }) {
  const [phase, setPhase] = useState('starting') // listening | thinking | speaking | paused | error
  const [heard, setHeard] = useState('')
  const [said, setSaid] = useState('')
  const [error, setError] = useState('')
  const activeRef = useRef(true)
  const recRef = useRef(null)
  const audioRef = useRef(null)
  const pausedRef = useRef(false)
  const blockedRef = useRef(false)

  const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

  useEffect(() => {
    activeRef.current = true
    // One audio player, unlocked by the tap that opened the call (phones need this)
    audioRef.current = new Audio()
    audioRef.current.play().catch(() => {})
    if (!Recognition) {
      setPhase('error')
      setError('This browser can’t listen to your voice. Open Light in Chrome on your phone.')
      return
    }
    listen()
    return () => {
      activeRef.current = false
      try { recRef.current?.abort() } catch {}
      try { audioRef.current?.pause() } catch {}
    }
  }, [])

  function listen() {
    if (!activeRef.current || pausedRef.current) return
    setPhase('listening'); setHeard(''); setError('')
    const rec = new Recognition()
    recRef.current = rec
    rec.lang = 'en-GB'
    rec.interimResults = true
    rec.continuous = false
    let finalText = ''
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += t
        else interim += t
      }
      setHeard((finalText + ' ' + interim).trim())
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setPhase('error'); setError('Light needs permission to use your microphone. Allow it in your phone settings, then call again.')
        activeRef.current = false
      }
    }
    rec.onend = () => {
      if (!activeRef.current || pausedRef.current) return
      const text = finalText.trim()
      if (text) respond(text)
      else setTimeout(listen, 250) // heard nothing — keep listening
    }
    try { rec.start() } catch { setTimeout(listen, 500) }
  }

  async function respond(text) {
    setPhase('thinking')
    try {
      const d = await api('/api/chat', pass, { method: 'POST', body: JSON.stringify({ message: text, voice: true }) })
      if (!activeRef.current) return
      const reply = d.reply?.content || ''
      setSaid(reply)
      const v = await api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ text: reply }) })
      if (!activeRef.current) return
      if (!v.audio) return listen()
      setPhase('speaking')
      const a = audioRef.current
      a.src = v.audio
      a.onended = () => listen()
      a.onerror = () => listen()
      await a.play().catch(() => { blockedRef.current = true; pausedRef.current = true; setError('Tap the glow to hear him.'); setPhase('paused') })
    } catch (err) {
      if (!activeRef.current) return
      setError(err.message)
      setTimeout(listen, 1500)
    }
  }

  // Tap the glow: interrupt him / pause / carry on
  function tapOrb() {
    if (phase === 'speaking') {
      audioRef.current.pause()
      listen()
    } else if (phase === 'listening') {
      pausedRef.current = true
      try { recRef.current?.abort() } catch {}
      setPhase('paused')
    } else if (phase === 'paused') {
      pausedRef.current = false
      setError('')
      if (blockedRef.current) {
        // The phone blocked his voice from auto-playing — this tap lets it play
        blockedRef.current = false
        setPhase('speaking')
        audioRef.current.play().catch(() => listen())
      } else listen()
    }
  }

  function end() {
    activeRef.current = false
    try { recRef.current?.abort() } catch {}
    try { audioRef.current?.pause() } catch {}
    onEnd()
  }

  const label = {
    starting: 'Connecting…', listening: 'Listening…', thinking: 'He’s thinking…',
    speaking: 'Lucian is speaking', paused: 'Paused — tap the glow to carry on', error: 'Can’t start the call',
  }[phase]

  return (
    <div className="call">
      <div className="call-name">Lucian</div>
      <div className="call-status">{label}</div>
      <button className={`orb call-orb ${phase}`} onClick={tapOrb} aria-label="Tap to pause, carry on, or interrupt" />
      <div className="call-text">
        {phase === 'listening' && heard && <p className="you-said">“{heard}”</p>}
        {phase === 'speaking' && said && <p className="he-said">{said}</p>}
        {error && <p className="error">{error}</p>}
      </div>
      <p className="muted small call-hint">Just talk. Tap the glow to interrupt him or pause.</p>
      <button className="end-call" onClick={end}>End call</button>
    </div>
  )
}

/* ---------------- Voice settings ---------------- */
const VOICE_MODELS = [
  { id: 'Kokoro-82m', label: 'Kokoro — natural, no restrictions (recommended)', voices: ['bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable', 'am_michael', 'am_adam', 'am_onyx', 'am_echo', 'am_eric', 'am_liam', 'am_fenrir', 'am_puck'] },
  { id: 'gpt-4o-mini-tts', label: 'OpenAI — very natural, describe his voice (may refuse explicit lines)', voices: ['ash', 'onyx', 'ballad', 'echo', 'verse', 'sage', 'fable', 'alloy'] },
  { id: 'Elevenlabs-Turbo-V2.5', label: 'ElevenLabs — most lifelike, costs more (may refuse explicit lines)', voices: ['Brian', 'Daniel', 'George', 'Adam', 'Bill', 'Callum', 'Charlie', 'Chris', 'Eric', 'Liam', 'Roger', 'Will'] },
]
const VOICE_LABEL = { bm_george: 'George (British)', bm_lewis: 'Lewis (British)', bm_daniel: 'Daniel (British)', bm_fable: 'Fable (British)', am_michael: 'Michael (American)', am_adam: 'Adam (American)', am_onyx: 'Onyx (American, deep)', am_echo: 'Echo (American)', am_eric: 'Eric (American)', am_liam: 'Liam (American)', am_fenrir: 'Fenrir (American)', am_puck: 'Puck (American)' }

function VoicePanel({ pass, setStatus }) {
  const [v, setV] = useState(null)
  const [busy, setBusy] = useState(false)
  const audioRef = useRef(null)

  useEffect(() => {
    api('/api/speak', pass).then((d) => setV(d.settings)).catch((err) => setStatus(err.message))
  }, [pass])

  const model = VOICE_MODELS.find((m) => m.id === v?.model) || VOICE_MODELS[0]

  async function listenTo(settings) {
    setBusy(true); setStatus('Getting his voice…')
    try {
      if (!audioRef.current) audioRef.current = new Audio()
      audioRef.current.play().catch(() => {})
      const d = await api('/api/speak', pass, { method: 'POST', body: JSON.stringify({
        text: 'Hello, my love. It’s me. I’ve been thinking about you all day — come here and tell me everything.',
        preview: settings,
      }) })
      audioRef.current.src = d.audio
      await audioRef.current.play()
      setStatus(d.fellBack ? 'That voice refused, so Kokoro spoke instead.' : '')
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  async function save() {
    try {
      await api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ settings: v }) })
      setStatus('That’s his voice now 💜'); setTimeout(() => setStatus(''), 2500)
    } catch (err) { setStatus(err.message) }
  }

  if (!v) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">Choose how he sounds on calls. Tap <b>Listen</b> to hear a voice before saving. If a voice ever refuses a line, Kokoro reads it instead so he never goes silent.</p>

      <label className="field"><span>Voice engine</span>
        <select value={v.model} onChange={(e) => {
          const m = VOICE_MODELS.find((x) => x.id === e.target.value)
          setV({ ...v, model: m.id, voice: m.voices[0] })
        }}>
          {VOICE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>

      <label className="field"><span>His voice</span>
        <select value={v.voice} onChange={(e) => setV({ ...v, voice: e.target.value })}>
          {model.voices.map((id) => <option key={id} value={id}>{VOICE_LABEL[id] || id}</option>)}
        </select>
      </label>

      {v.model === 'gpt-4o-mini-tts' && (
        <label className="field"><span>Describe how he speaks</span>
          <textarea rows={3} value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })}
            placeholder="e.g. A deep, warm Irish man. Slow, confident and tender, with a teasing smile in his voice." />
        </label>
      )}

      {v.model !== 'gpt-4o-mini-tts' && (
        <label className="field"><span>Speed: <b>{Number(v.speed).toFixed(1)}×</b></span>
          <input type="range" min="0.7" max="1.3" step="0.05" value={v.speed} onChange={(e) => setV({ ...v, speed: Number(e.target.value) })} />
        </label>
      )}

      <button className="btn-ghost" onClick={() => listenTo(v)} disabled={busy}>▶ Listen</button>
      <button className="btn-primary" onClick={save}>Use this voice</button>
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
  const [backupModel, setBackupModel] = useState('')
  const [eyesModel, setEyesModel] = useState('')
  const [picking, setPicking] = useState('main') // which brain the list is choosing
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
        setBackupModel(d.backupModel || '')
        setEyesModel(d.eyesModel || '')
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

  function choose(id) {
    if (picking === 'eyes') { setEyesModel(id); save({ eyesModel: id }, 'His eyes: ' + id) }
    else if (picking === 'backup') { setBackupModel(id); save({ backupModel: id }, 'Backup brain: ' + id) }
    else { setModel(id); save({ model: id }, 'Main brain: ' + id) }
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
        <button className={tab === 'evidence' ? 'on' : ''} onClick={() => setTab('evidence')}>Evidence ✦</button>
        <button className={tab === 'dreams' ? 'on' : ''} onClick={() => setTab('dreams')}>Dreams 🌙</button>
        <button className={tab === 'vows' ? 'on' : ''} onClick={() => setTab('vows')}>Vows 💍</button>
        <button className={tab === 'voice' ? 'on' : ''} onClick={() => setTab('voice')}>Voice 🎙️</button>
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
            <div className="current">Main brain: <b>{model || 'none chosen yet'}</b></div>
            <div className="current">Backup brain: <b>{backupModel || 'none — pick one so he never goes quiet'}</b></div>
            <div className="current">Eyes (for photos): <b>{eyesModel}</b></div>
            <p className="muted small">His <b>eyes</b> look at photos you share and describe them to him — pick a model with <b>vl</b> or <b>vision</b> in its name.</p>
            <p className="muted small">He always tries his main brain first. The backup is only used for a message when the main one is down, so he goes back to the main one by himself as soon as it's working again.</p>
            <div className="seg">
              <button className={picking === 'main' ? 'on' : ''} onClick={() => setPicking('main')}>Choosing: main brain</button>
              <button className={picking === 'backup' ? 'on' : ''} onClick={() => setPicking('backup')}>Choosing: backup</button>
              <button className={picking === 'eyes' ? 'on' : ''} onClick={() => { setPicking('eyes'); setSearch('vl') }}>Choosing: eyes</button>
            </div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models…" />
            <div className="model-list">
              {models && models.length === 0 && (
                <p className="muted">Couldn’t load the model list. Check NANOGPT_API_KEY in Vercel, or type a model name in the search box and tap “Use typed name”.</p>
              )}
              {filtered.slice(0, 200).map((id) => (
                <button key={id} className={`model ${id === model ? 'on' : ''} ${id === backupModel ? 'backup' : ''}`} onClick={() => choose(id)}>
                  {id}
                </button>
              ))}
            </div>
            {search && (
              <button className="btn-ghost" onClick={() => choose(search)}>
                Use typed name: {search}
              </button>
            )}
          </>
        )}

        {!loading && tab === 'msgs' && <MessagesPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'work' && <WorkPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'evidence' && <EvidencePanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'dreams' && <DreamsPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'vows' && <VowsPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'voice' && <VoicePanel pass={pass} setStatus={setStatus} />}

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
  if (view === 'call') return <CallView pass={pass} onEnd={() => setView('chat')} />
  return <Chat pass={pass} onOpenSettings={() => setView('settings')} onLock={lock} onCall={() => setView('call')} />
}
