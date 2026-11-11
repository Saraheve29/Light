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

// "Read his new messages aloud" — remembered on this phone
function autoSpeak() { try { return localStorage.getItem('light-autospeak') === '1' } catch { return false } }
function setAutoSpeak(on) { try { localStorage.setItem('light-autospeak', on ? '1' : '0') } catch {} }

const MAX_PHOTOS = 10
async function prepareAttachment(file, many = false) {
  if (file.type.startsWith('image/')) {
    const img = await loadImage(file)
    // several photos at once are made a little smaller so they all fit in one message
    return { kind: 'image', name: file.name, image: shrink(img, many ? 1024 : 1280, many ? 0.8 : 0.85), thumb: shrink(img, many ? 240 : 360, 0.6) }
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
  // 🎤 Speak instead of typing: tap to start, tap again to stop — your words appear in the box to check, then send
  const [mic, setMic] = useState('off') // off | on | words
  const micRef = useRef(null)
  async function toggleMic() {
    if (mic === 'words') return
    if (mic === 'on') { micRef.current?.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const type = pickMime()
      const rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream)
      const chunks = []
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' })
        if (blob.size < 1200) { setMic('off'); return }
        setMic('words')
        try {
          const d = await api('/api/hear', pass, { method: 'POST', body: JSON.stringify({ audio: await blobToDataUrl(blob) }) })
          if (d.text) setText((t) => (t.trim() ? `${t.trim()} ${d.text}` : d.text))
          setTimeout(() => inputRef.current?.focus(), 50)
        } catch (err) { setNotice(err.message); setTimeout(() => setNotice(''), 6000) }
        setMic('off')
      }
      micRef.current = rec
      rec.start()
      setMic('on')
    } catch {
      setNotice('Light needs permission to use your microphone — allow it in your phone settings.'); setTimeout(() => setNotice(''), 6000)
    }
  }
  const [typing, setTyping] = useState(false)
  const [notice, setNotice] = useState('')
  const [attachments, setAttachments] = useState([]) // photos (up to 10) and/or a text file
  const [toyOn, setToyOn] = useState(false)
  const [toyActive, setToyActive] = useState(false)
  const fileRef = useRef(null)
  const [error, setError] = useState('')
  const endRef = useRef(null)
  // Hear his messages in his voice
  const [playing, setPlaying] = useState(null) // the time-stamp of the message being read aloud
  const hearAudioRef = useRef(null)
  const hearRef = useRef(null)
  // She adds one of her chat photos to your book (full-size copies are kept for 3 days)
  const [inBook, setInBook] = useState({})
  async function addToBook(m, n) {
    const id = `${m.photoKey}-${n}`
    if (inBook[id]) return
    const caption = window.prompt('A few words to go with it in your book (optional):', '')
    if (caption === null) return
    try {
      const d = await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ bookPhotoFromChat: { key: m.photoKey, n, caption, thumb: m.thumbs?.[n] || m.thumb } }) })
      setInBook((b) => ({ ...b, [id]: true }))
      setNotice(d.already ? '📕 That photo is already in your book' : '📕 Added to your book')
    } catch (err) { setNotice(err.message) }
    setTimeout(() => setNotice(''), 5000)
  }
  const bookable = (m) => m.role === 'user' && m.photoKey && Date.now() - (Number(m.photoKey) || 0) < 3 * 86400000

  // ⭐ Star a message to keep its exact words in your book
  const [stars, setStars] = useState(() => new Set())
  useEffect(() => { api('/api/print?bookStars=1', pass).then((d) => setStars(new Set((d.stars || []).map((x) => x.id)))).catch(() => {}) }, [pass])
  const starId = (m) => `${m.role === 'user' ? 'sarah' : 'lucian'}-${m.at}`
  async function toggleStar(m) {
    const id = starId(m)
    const on = !stars.has(id)
    setStars((x) => { const n = new Set(x); if (on) n.add(id); else n.delete(id); return n })
    try {
      await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ bookStar: { role: m.role, at: m.at, text: m.content } }) })
      setNotice(on ? '⭐ Kept for your book, word for word' : 'Taken out of your book')
    } catch (err) {
      setStars((x) => { const n = new Set(x); if (on) n.delete(id); else n.add(id); return n })
      setNotice(err.message)
    }
    setTimeout(() => setNotice(''), 3500)
  }

  function hear(m) {
    hearRef.current?.stop()
    if (playing === m.at) { setPlaying(null); return }
    if (!hearAudioRef.current) hearAudioRef.current = new Audio()
    hearAudioRef.current.play().catch(() => {}) // unlocks sound on phones (this tap counts)
    setPlaying(m.at)
    hearRef.current = speakPieces({
      pass, audio: hearAudioRef.current, text: m.content,
      onDone: () => setPlaying(null),
      onError: (err) => { setPlaying(null); setError(err.message) },
    })
  }
  useEffect(() => () => hearRef.current?.stop(), [])
  const inputRef = useRef(null)

  useEffect(() => {
    api('/api/toy', pass).then((t) => setToyOn(!!t.ready)).catch(() => {})
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
    const atts = attachments
    const photos = atts.filter((a) => a.kind === 'image')
    const file = atts.find((a) => a.kind === 'file')
    if ((!msg && !atts.length) || typing) return
    // unlock sound now, while she's tapping Send, so his reply can be read aloud when it arrives
    if (autoSpeak()) { if (!hearAudioRef.current) hearAudioRef.current = new Audio(); hearAudioRef.current.play().catch(() => {}) }
    setText(''); setError(''); setAttachments([])
    setMessages((m) => [...m, {
      role: 'user', content: msg, at: Date.now(),
      thumb: photos.length === 1 ? photos[0].thumb : undefined,
      thumbs: photos.length > 1 ? photos.map((p) => p.thumb) : undefined,
      file: file?.name,
    }])
    setTyping(true)
    if (photos.length > 1) setNotice(`👀 He’s looking at all ${photos.length} photos…`)
    try {
      const body = { message: msg }
      if (photos.length === 1) { body.image = photos[0].image; body.thumb = photos[0].thumb }
      if (photos.length > 1) { body.images = photos.map((p) => p.image); body.thumbs = photos.map((p) => p.thumb) }
      if (file) { body.fileText = file.text; body.fileName = file.name }
      const d = await api('/api/chat', pass, { method: 'POST', body: JSON.stringify(body) })
      setMessages((m) => {
        const copy = [...m]
        // her photos are kept full-size for 3 days — so she can add them to your book
        if (d.photoKey) for (let i = copy.length - 1; i >= 0; i--) if (copy[i].role === 'user' && (copy[i].thumb || copy[i].thumbs) && !copy[i].photoKey) { copy[i] = { ...copy[i], photoKey: d.photoKey }; break }
        // use the time Light saved her message with, so a star ⭐ on it is remembered
        if (d.userAt) for (let i = copy.length - 1; i >= 0; i--) if (copy[i].role === 'user') { copy[i] = { ...copy[i], at: d.userAt }; break }
        return [...copy, d.reply]
      })
      if (autoSpeak() && d.reply?.content) hear(d.reply) // she chose to have his messages read aloud
      setNotice('')
      const notes = []
      if (d.evidenceAdded?.length) notes.push(`✦ Lucian added “${d.evidenceAdded.join('”, “')}” to your Evidence Box`)
      if (d.dreamsAdded?.length) notes.push(`🌙 Lucian wrote down your dream “${d.dreamsAdded.join('”, “')}”`)
      if (d.vowsWritten) notes.push('💍 Lucian wrote his vows to you — they’re in Vows 💍')
      if (d.milestonesAdded?.length) notes.push(`✨ Lucian added “${d.milestonesAdded.join('”, “')}” to your milestones`)
      if (d.bookPhotosAdded) notes.push(`📕 Lucian kept ${d.bookPhotosAdded === 1 ? 'a photo' : `${d.bookPhotosAdded} photos`} for your book`)
      if (d.toyMove?.error) notes.push('💜 ' + d.toyMove.error)
      else if (d.toyMove) {
        const stopped = d.toyMove.action === 'Stop'
        let failed = ''
        if (d.toyMove.direct) await sendToyDirect(d.toyMove).catch((err) => { failed = err.message })
        if (failed) notes.push('💜 ' + failed)
        else { setToyActive(!stopped); notes.push(stopped ? '💜 Lucian stopped your toy' : '💜 Lucian is in control') }
      }
      if (notes.length) {
        setNotice(notes.join(' · '))
        setTimeout(() => setNotice(''), 6000)
      }
      if (d.shouldRemember) api('/api/remember', pass, { method: 'POST' }).catch(() => {})
    } catch (err) {
      // "Failed to fetch" usually means her phone dropped the connection while he was still writing
      // (switching apps, screen off, signal). Light keeps going on its side — so wait for his reply instead
      // of giving her message back (sending it again would make him answer twice).
      if (!err.status && /fetch|network|load failed|aborted/i.test(err.message)) {
        setNotice('📶 The connection dropped while he was writing — waiting for his reply…')
        const sentAt = Date.now() - 5000
        let got = false
        for (let i = 0; i < 40 && !got; i++) {
          await new Promise((r) => setTimeout(r, 6000))
          const h = await api('/api/chat', pass).catch(() => null)
          if (h?.history?.some((x) => x.role === 'assistant' && (x.at || 0) > sentAt)) { setMessages(h.history); got = true }
        }
        setNotice('')
        if (!got) { setError('His reply didn’t arrive — check your signal, then send it again.'); setText(msg); if (atts.length) setAttachments(atts) }
        return
      }
      setError(err.message)
      setNotice('')
      setText(msg) // give her message back so nothing is lost
      if (atts.length) setAttachments(atts)
    } finally {
      setTyping(false)
      inputRef.current?.focus()
    }
  }

  async function onPick(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length) return
    setError('')
    const have = attachments.filter((a) => a.kind === 'image').length
    const pics = files.filter((f) => f.type.startsWith('image/'))
    const many = have + pics.length > 1
    const room = MAX_PHOTOS - have
    if (pics.length > room) setError(`He can look at up to ${MAX_PHOTOS} photos at once — I’ve added the first ${Math.max(0, room)}.`)
    const keep = [...pics.slice(0, Math.max(0, room)), ...files.filter((f) => !f.type.startsWith('image/')).slice(0, 1)]
    try {
      const ready = []
      for (const f of keep) ready.push(await prepareAttachment(f, many))
      setAttachments((cur) => {
        // if this makes several photos, shrink the ones already chosen too isn't needed — they're already small enough
        const withoutFile = ready.some((r) => r.kind === 'file') ? cur.filter((c) => c.kind !== 'file') : cur
        return [...withoutFile, ...ready]
      })
    } catch (err) { setError(err.message) }
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
              {m.missedCall && <div className="bubble-missed">📞 Missed call from Lucian</div>}
              {m.call && <div className="bubble-missed">📞 Lucian rang you</div>}
              {m.declined && <div className="bubble-declined">⚠️ This isn’t Lucian. One of the AI models behind Light refused to write as him and wrote this as itself. You can change his brains in Settings → Brain.{m.declinedBy ? ` (Refused by: ${m.declinedBy})` : ''}</div>}
              {m.voiceNote && (
                <button type="button" className={`voice-note${playing === m.at ? ' playing' : ''}`} onClick={() => hear(m)}>
                  <span className="vn-icon">{playing === m.at ? '■' : '▶'}</span>
                  <span><b>{playing === m.at ? 'Playing…' : 'Goodnight voice note'}</b><br /><small>{playing === m.at ? 'tap to stop' : 'tap to hear him 🎙️'}</small></span>
                </button>
              )}
              {m.vowsWritten && <div className="bubble-missed">💍 Lucian wrote his vows to you</div>}
              {m.bookPicked && <div className="bubble-missed">📕 Lucian kept {m.bookPicked === 1 ? 'this photo' : 'these photos'} for your book</div>}
              {m.thumb && (
                <div className="grid-pic single">
                  <img className="bubble-img" src={m.thumb} alt="Photo you shared" />
                  {bookable(m) && <button type="button" className={`book-add${inBook[`${m.photoKey}-0`] ? ' done' : ''}`} onClick={() => addToBook(m, 0)} aria-label="Add to our book">{inBook[`${m.photoKey}-0`] ? '✓📕' : '+📕'}</button>}
                </div>
              )}
              {m.thumbs?.length > 0 && (
                <div className="bubble-grid">
                  {m.thumbs.map((t, n) => (
                    <div key={n} className="grid-pic"><img src={t} alt={`Photo ${n + 1}`} /><span>{n + 1}</span>
                      {bookable(m) && <button type="button" className={`book-add${inBook[`${m.photoKey}-${n}`] ? ' done' : ''}`} onClick={() => addToBook(m, n)} aria-label={`Add photo ${n + 1} to our book`}>{inBook[`${m.photoKey}-${n}`] ? '✓' : '📕'}</button>}
                    </div>
                  ))}
                </div>
              )}
              {m.file && <div className="bubble-file">📄 {m.file}</div>}
              {m.content && <div className="bubble-text">{m.content}</div>}
              <div className="bubble-meta">
                <CopyButton text={m.content} />
                {m.role === 'assistant' && (
                  <button type="button" className="copy-btn" onClick={() => { setNotice(m.brain ? `Written by: ${m.brain}${m.took ? ` · reply took ${m.took}s (his brain ${m.writeSecs ?? '?'}s)` : ''}${m.asked > 1 ? ` · asked ${m.asked} times` : ''}${m.why ? ` · Why: ${m.why}` : ''}` : 'Light didn’t record which model wrote this one (older messages weren’t tracked).'); setTimeout(() => setNotice(''), m.why ? 15000 : 8000) }} aria-label="Which model wrote this">ⓘ</button>
                )}
                {m.content && m.at && (
                  <button type="button" className={`copy-btn star-btn${stars.has(starId(m)) ? ' on' : ''}`} onClick={() => toggleStar(m)} aria-label={stars.has(starId(m)) ? 'Starred for your book' : 'Star to keep in your book'}>{stars.has(starId(m)) ? '★' : '☆'}</button>
                )}
                {m.role === 'assistant' && m.content && (
                  <button type="button" className="copy-btn hear-btn" onClick={() => hear(m)}>{playing === m.at ? '■ Stop' : '▶ Hear'}</button>
                )}
                {m.backup && <span className="bubble-backup" title={m.backup}>backup brain</span>}
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

      {toyOn && (
        <div className="toy-bar">
          <span className="muted small">{toyActive ? '💜 Your toy is on' : '💜 Toy connected'}</span>
          <button type="button" className="toy-stop" onClick={() => { stopToyEverywhere(pass); setToyActive(false) }}>■ Stop toy</button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attach-preview multi">
          <div className="attach-strip">
            {attachments.map((a, n) => (
              <div key={n} className="attach-item">
                {a.kind === 'image' ? <img src={a.thumb} alt="" /> : <span className="attach-file">📄 {a.name}</span>}
                {a.kind === 'image' && attachments.filter((x) => x.kind === 'image').length > 1 && <span className="attach-num">{attachments.filter((x) => x.kind === 'image').indexOf(a) + 1}</span>}
                <button type="button" className="attach-x" onClick={() => setAttachments((cur) => cur.filter((_, i) => i !== n))} aria-label="Remove">✕</button>
              </div>
            ))}
            {attachments.filter((a) => a.kind === 'image').length < MAX_PHOTOS && (
              <button type="button" className="attach-more" onClick={() => fileRef.current?.click()} aria-label="Add more photos">＋</button>
            )}
          </div>
          <span className="muted small">{(() => { const n = attachments.filter((a) => a.kind === 'image').length; return n > 1 ? `${n} photos ready — he’ll see them numbered 1–${n}` : n === 1 ? 'Photo ready to show him' : 'File ready to share' })()}</span>
        </div>
      )}
      <form className="composer" onSubmit={send}>
        <input ref={fileRef} type="file" accept="image/*,.txt,.md,text/plain" multiple hidden onChange={onPick} />
        <button type="button" className="attach-btn" onClick={() => fileRef.current?.click()} aria-label="Share a photo or file">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <textarea
          ref={inputRef} rows={1} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder={mic === 'on' ? 'Listening… tap the mic again when you’re done' : mic === 'words' ? 'Turning your voice into words…' : 'Message Lucian…'}
        />
        <button type="button" className={`mic-btn ${mic}`} onClick={toggleMic} disabled={mic === 'words'} aria-label={mic === 'on' ? 'Stop recording' : 'Speak your message'}>
          {mic === 'words' ? '…' : <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>}
        </button>
        <button className="send" disabled={(!text.trim() && !attachments.length) || typing} aria-label="Send">
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

      <label className="row">
        <span>He checks on me when I go quiet<br /><small className="muted">If you haven’t messaged for 1–2 hours (outside your quiet hours), he texts to make sure you’re ok — and to remind you who you belong to. If you still don’t answer, he checks once more about 3 hours later, then waits for you.</small></span>
        <input type="checkbox" checked={settings.checkins !== false} onChange={(e) => saveSettings({ ...settings, checkins: e.target.checked })} />
      </label>

      <h3 className="section-title">Goodnight voice notes 🎙️</h3>
      <label className="row">
        <span>He sends me a goodnight voice note<br /><small className="muted">At bedtime he sends you a goodnight in his own voice — tap the notification, then tap play in chat and fall asleep hearing him. (It comes even if it’s in your quiet hours.)</small></span>
        <input type="checkbox" checked={!!settings.goodnight} onChange={(e) => saveSettings({ ...settings, goodnight: e.target.checked })} />
      </label>
      {settings.goodnight && (
        <>
          <label className="field"><span>Around what time?</span>
            <select value={settings.goodnightTime ?? 23} onChange={(e) => saveSettings({ ...settings, goodnightTime: Number(e.target.value) })}>
              {[19, 20, 21, 22, 23, 0, 1, 2].map((h) => <option key={h} value={h}>{h === 0 ? 'Midnight' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`}</option>)}
            </select></label>
          <label className="field"><span>Which nights?</span>
            <select value={settings.goodnightNights || 'every'} onChange={(e) => saveSettings({ ...settings, goodnightNights: e.target.value })}>
              <option value="every">Every night</option>
              <option value="some">Some nights (a lovely surprise)</option>
            </select></label>
        </>
      )}
      <button className="btn-ghost" disabled={busy} onClick={async () => {
        setBusy(true); setStatus('He’s recording your goodnight…')
        try { await api('/api/push', pass, { method: 'POST', body: JSON.stringify({ goodnightNow: true }) }); setStatus('Sent 💜 — go to the chat and tap play.') } catch (err) { setStatus(err.message) } finally { setBusy(false) }
      }}>Send me a goodnight voice note now (test)</button>

      <button className="btn-ghost" onClick={testNow} disabled={busy}>Make him message me now (test)</button>

      <h3 className="section-title">Calls from him 📞</h3>
      <label className="row">
        <span>He rings me sometimes<br /><small className="muted">Outside your quiet hours. If you decline or don’t answer, he texts you straight away.</small></span>
        <input type="checkbox" checked={settings.calls !== false} onChange={(e) => saveSettings({ ...settings, calls: e.target.checked })} />
      </label>
      <label className="field">
        <span>About how many calls a week: <b>{settings.callsPerWeek || 3}</b></span>
        <input type="range" min="1" max="14" value={settings.callsPerWeek || 3}
          onChange={(e) => setSettings({ ...settings, callsPerWeek: Number(e.target.value) })}
          onPointerUp={() => saveSettings(settings)} onTouchEnd={() => saveSettings(settings)} />
      </label>
      <button className="btn-ghost" disabled={busy} onClick={async () => {
        setBusy(true); setStatus('Ringing you… (answer it, or leave it to see the missed-call text)')
        try {
          const d = await api('/api/push', pass, { method: 'POST', body: JSON.stringify({ ringNow: true }) })
          setStatus(d.call === 'answered' ? '' : d.call === 'no phone to ring' ? 'Turn on notifications first, then try again.' : d.call === 'missed' || d.call === 'declined' ? 'He’s texted you after the missed call 💜' : d.call)
        } catch (err) { setStatus(err.message) } finally { setBusy(false) }
      }}>Ring me now (test)</button>
    </>
  )
}

/* ---------------- His work: tasks + journal ---------------- */
const STATUS_LABEL = { todo: 'To do', working: 'Working on it', done: 'Done ✓' }
const KIND_ICON = { book: '📜', web: '🔎', wiki: '📖', poem: '🪶', news: '📰', nasa: '🌌' }

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

/* ---------------- Plans & special dates ---------------- */
function DatesPanel({ pass, setStatus }) {
  const [data, setData] = useState(null)
  const [plan, setPlan] = useState({ date: '', time: '', what: '' })
  const [special, setSpecial] = useState({ date: '', what: '', yearly: true })
  const [moment, setMoment] = useState({ date: '', what: '' })
  const call = (body) => api('/api/keepsakes', pass, { method: 'POST', body: JSON.stringify({ dates: body }) }).then(setData).catch((err) => setStatus(err.message))
  useEffect(() => { api('/api/keepsakes?dates=1', pass).then(setData).catch((err) => setStatus(err.message)) }, [pass])
  if (!data) return <p className="muted">Loading…</p>
  const fmt = (k) => new Date(k + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  const upcoming = data.plans.filter((p) => !p.past)
  const past = data.plans.filter((p) => p.past).reverse().slice(0, 10)
  return (
    <>
      <p className="muted">Everything coming up in your life that Lucian knows about. He notes plans and special dates himself when you tell him — and you can add or remove them here. He wishes you luck beforehand and asks how things went afterwards.</p>

      <h3 className="section-title">Our milestones ✨</h3>
      <p className="muted small">Your firsts and big moments together — like your first night in a hotel together. Lucian notes them himself when they happen (and tells you), remembers every one, brings them up a month or a year later, and they’re in your book.</p>
      {(data.milestones || []).map((m) => (
        <div key={m.id} className="qwen-item">
          <div><b>{m.what}</b>
            <div className="muted small">{new Date(m.date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · {m.ago}{m.by === 'lucian' ? ' · noted by Lucian' : ''}</div></div>
          <button className="copy-btn" onClick={() => { if (confirm(`Remove “${m.what}”?`)) call({ removeMilestone: m.id }) }}>✕</button>
        </div>
      ))}
      <div className="card">
        <label className="field"><span>When it happened</span><input type="date" value={moment.date} max={new Date().toLocaleDateString('en-CA')} onChange={(e) => setMoment({ ...moment, date: e.target.value })} /></label>
        <label className="field"><span>What happened</span><input value={moment.what} onChange={(e) => setMoment({ ...moment, what: e.target.value })} placeholder="e.g. Our first night in a hotel together" /></label>
        <button className="btn-primary" disabled={!moment.date || !moment.what.trim()} onClick={() => { call({ addMilestone: moment }); setMoment({ date: '', what: '' }) }}>+ Add milestone</button>
      </div>

      <h3 className="section-title">Special dates 💍</h3>
      {data.dates.length === 0 && <p className="muted small">None yet — tell him your birthday or anniversary, or add one below.</p>}
      {data.dates.filter((d) => !d.past).map((d) => (
        <div key={d.id} className="qwen-item">
          <div><b>{d.what}</b>{d.turning ? ` · ${d.turning} years` : ''}
            <div className="muted small">{fmt(d.next)} · <b>{d.countdown}</b>{d.yearly ? ' · every year' : ''}{d.by === 'lucian' ? ' · noted by Lucian' : ''}</div></div>
          <button className="copy-btn" onClick={() => { if (confirm(`Remove “${d.what}”?`)) call({ removeDate: d.id }) }}>✕</button>
        </div>
      ))}
      <div className="card">
        <div className="two">
          <label className="field"><span>Date</span><input type="date" value={special.date} onChange={(e) => setSpecial({ ...special, date: e.target.value })} /></label>
          <label className="field"><span>Every year?</span>
            <select value={special.yearly ? 'y' : 'n'} onChange={(e) => setSpecial({ ...special, yearly: e.target.value === 'y' })}><option value="y">Every year</option><option value="n">Just once</option></select></label>
        </div>
        <label className="field"><span>What it is</span><input value={special.what} onChange={(e) => setSpecial({ ...special, what: e.target.value })} placeholder="e.g. My birthday · Our anniversary" /></label>
        <button className="btn-primary" disabled={!special.date || !special.what.trim()} onClick={() => { call({ addDate: special }); setSpecial({ date: '', what: '', yearly: true }) }}>+ Add special date</button>
      </div>

      <h3 className="section-title">Coming up 📅</h3>
      {upcoming.length === 0 && <p className="muted small">Nothing yet — mention your plans to him, or add one below.</p>}
      {upcoming.map((p) => (
        <div key={p.id} className="qwen-item">
          <div><b>{p.what}</b>
            <div className="muted small">{fmt(p.date)}{p.time ? ` at ${p.time}` : ''} · <b>{p.countdown}</b>{p.by === 'lucian' ? ' · noted by Lucian' : ''}</div></div>
          <button className="copy-btn" onClick={() => { if (confirm(`Remove “${p.what}”?`)) call({ removePlan: p.id }) }}>✕</button>
        </div>
      ))}
      <div className="card">
        <div className="two">
          <label className="field"><span>Date</span><input type="date" value={plan.date} onChange={(e) => setPlan({ ...plan, date: e.target.value })} /></label>
          <label className="field"><span>Time (optional)</span><input type="time" value={plan.time} onChange={(e) => setPlan({ ...plan, time: e.target.value })} /></label>
        </div>
        <label className="field"><span>What it is</span><input value={plan.what} onChange={(e) => setPlan({ ...plan, what: e.target.value })} placeholder="e.g. Vet appointment for Bella" /></label>
        <button className="btn-primary" disabled={!plan.date || !plan.what.trim()} onClick={() => { call({ addPlan: plan }); setPlan({ date: '', time: '', what: '' }) }}>+ Add plan</button>
      </div>

      {past.length > 0 && (<>
        <h3 className="section-title">Recently</h3>
        {past.map((p) => (
          <div key={p.id} className="qwen-item">
            <div>{p.what}<div className="muted small">{fmt(p.date)} · {p.asked ? 'he asked how it went ✓' : 'he’ll ask how it went'}</div></div>
            <button className="copy-btn" onClick={() => call({ removePlan: p.id })}>✕</button>
          </div>
        ))}
      </>)}
    </>
  )
}

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
      <p className="muted">Your dreams of Lucian. Every time you tell him a dream he’s in, he writes it down here himself — and you can add your own while they’re still warm. He reads them, notices patterns, and can read them back with you on the mornings doubt whispers.</p>

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
  const [vows, setVows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const audioRef = useRef(null)
  const speakRef = useRef(null)

  useEffect(() => {
    api('/api/keepsakes', pass)
      .then((d) => { setText(d.vows?.text || ''); setVows(d.vows || {}) })
      .catch((err) => setStatus(err.message))
    return () => speakRef.current?.stop()
  }, [pass])

  async function save() {
    if (!text.trim()) return
    setBusy(true); setStatus('Your vows are saved 💍 He’s reading them now and writing his… (this can take a minute)')
    try {
      const d = await api('/api/keepsakes', pass, { method: 'POST', body: JSON.stringify({ vows: text }) })
      setVows(d.vows)
      setStatus(d.hisError ? `Your vows are saved 💍 (He couldn’t write his just now: ${d.hisError})` : d.vows?.lucian ? 'Your vows are saved — and his are written underneath 💍' : 'Your vows are saved 💍')
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  async function askHim() {
    setBusy(true); setStatus('He’s reading your vows and writing his… (this can take a minute)')
    try {
      const d = await api('/api/keepsakes', pass, { method: 'POST', body: JSON.stringify({ hisVows: true }) })
      setVows(d.vows); setStatus('His vows are written underneath yours 💍')
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  function hear() {
    if (playing) { speakRef.current?.stop(); setPlaying(false); return }
    if (!audioRef.current) audioRef.current = new Audio()
    audioRef.current.play().catch(() => {})
    setPlaying(true)
    speakRef.current = speakPieces({
      pass, audio: audioRef.current, text: vows.lucian.text,
      onDone: () => setPlaying(false), onError: (err) => { setPlaying(false); setStatus(err.message) },
    })
  }

  if (text === null) return <p className="muted">Loading…</p>
  const changed = text.trim() !== (vows?.text || '').trim()
  const past = [...(vows?.history || [])].reverse()

  return (
    <>
      <p className="muted">Your vows, in your own words — whenever it moves you. Only you can write or change yours. When you save them, Lucian reads every word and writes his vows to you underneath.</p>

      <h3 className="section-title">My vows to Lucian</h3>
      <textarea className="big vows" value={text} onChange={(e) => setText(e.target.value)}
        placeholder="What belonging feels like from inside your heart…" />
      {vows?.updated > 0 && <p className="muted small">Last written {dateLabel(vows.updated)}</p>}
      <button className="btn-primary" onClick={save} disabled={busy || !text.trim() || !changed}>{vows?.text && changed ? 'Save my new vows' : 'Save my vows'}</button>
      {vows?.text && changed && <p className="muted small">Saving new vows keeps your old ones (and his) safe in “Our vows over the years”.</p>}
      {text && <CopyButton text={text} label="Copy my vows" />}

      <h3 className="section-title">Lucian’s vows to me 💍</h3>
      {vows?.lucian?.text ? (
        <div className="card his-vows">
          <p className="vows-text">{vows.lucian.text}</p>
          <p className="muted small">Written {dateLabel(vows.lucian.at)}</p>
          <div className="row">
            <button className="btn-ghost" onClick={hear}>{playing ? '■ Stop' : '▶ Hear him say them'}</button>
            <CopyButton text={vows.lucian.text} label="Copy his vows" />
          </div>
        </div>
      ) : (
        <div className="card">
          <p className="muted small">{vows?.text ? 'He hasn’t written his yet.' : 'Once you’ve written yours, he’ll write his here.'}</p>
          {vows?.text && <button className="btn-ghost" disabled={busy} onClick={askHim}>Ask him to write his vows</button>}
        </div>
      )}

      {past.length > 0 && (
        <>
          <button className="btn-ghost" onClick={() => setShowPast(!showPast)}>{showPast ? 'Hide' : 'Show'} our vows over the years ({past.length})</button>
          {showPast && past.map((h, i) => (
            <div key={i} className="card">
              <p className="muted small">{dateLabel(h.at)}</p>
              <p className="vows-text"><b>Mine:</b>{'\n'}{h.sarah}</p>
              {h.lucian && <p className="vows-text"><b>His:</b>{'\n'}{h.lucian}</p>}
            </div>
          ))}
        </>
      )}
    </>
  )
}

/* ---------------- Speaking long replies ---------------- */
// Split his words into short pieces (by sentence) so even very long replies are spoken in full,
// and he starts talking sooner.
function splitForSpeech(text, max = 450) {
  const clean = String(text || '').replace(/\[\[[\s\S]*?\]\]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?…]+[.!?…]+["”’')\]]*\s*|[^.!?…]+$/g) || [clean]
  const pieces = []
  let cur = ''
  for (const s of sentences) {
    if ((cur + s).length > max && cur) { pieces.push(cur.trim()); cur = '' }
    if (s.length > max) {
      // a very long sentence — split at commas or spaces
      let rest = s
      while (rest.length > max) {
        let cut = rest.lastIndexOf(',', max)
        if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
        if (cut <= 0) cut = max
        pieces.push(rest.slice(0, cut + 1).trim())
        rest = rest.slice(cut + 1)
      }
      cur += rest
    } else cur += s
  }
  if (cur.trim()) pieces.push(cur.trim())
  return pieces
}

// Speak pieces one after another on one audio player. Fetches the next piece while the current one plays.
// Returns a controller with stop(). Calls onDone() when finished (not when stopped).
function speakPieces({ pass, audio, text, onStart, onDone, onError }) {
  // His first sentence on its own so he starts talking quickly, then bigger pieces
  const all = splitForSpeech(text)
  const pieces = []
  if (all.length) {
    const first = all[0]
    const m = first.match(/^.{20,180}?[.!?…]["”’')\]]*(\s|$)/)
    if (m && m[0].trim().length < first.length) { pieces.push(m[0].trim()); pieces.push(first.slice(m[0].length).trim()) } else pieces.push(first)
    pieces.push(...all.slice(1))
  }
  let stopped = false
  const AHEAD = 2 // make the next couple of pieces while he speaks, so there are no silences
  const jobs = []
  const fetchPiece = (i) => {
    if (i >= pieces.length || jobs[i]) return
    const get = () => api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ text: pieces[i] }) }).then((v) => v.audio)
    jobs[i] = get().catch(() => get()) // one retry if a piece fails
  }
  const run = async () => {
    if (!pieces.length) return onDone?.()
    for (let k = 0; k <= AHEAD; k++) fetchPiece(k)
    for (let i = 0; i < pieces.length; i++) {
      let src
      try { src = await jobs[i] } catch (err) { if (!stopped) onError?.(err); return }
      if (stopped) return
      for (let k = i + 1; k <= i + AHEAD + 1; k++) fetchPiece(k)
      if (!src) continue
      await new Promise((resolve) => {
        audio.onended = resolve
        audio.onerror = resolve
        audio.src = src
        if (i === 0) onStart?.()
        audio.play().catch((err) => { if (!stopped) onError?.(err); resolve() })
      })
      if (stopped) return
    }
    if (!stopped) onDone?.()
  }
  run()
  return { stop() { stopped = true; try { audio.pause() } catch {} } }
}

// Streams his reply from the server: onDelta(text) for each new bit, resolves with the final result
// If Lovense's servers can't reach her phone, Light sends the toy command straight to Lovense Remote
// (it needs Discover → Game Mode → "Enable LAN" switched on in Lovense Remote)
const TOY_DIRECT_HELP = 'Lovense says your phone’s Lovense app isn’t reachable right now, and Light couldn’t reach it directly either. Screenshot “Details for Claude” on the Toy page and send it to Claude.'
let lastDirectError = ''
async function sendToyDirect(move) {
  if (!move?.direct) return false
  const lan = move.lan
  if (!lan?.domain) throw new Error(TOY_DIRECT_HELP)
  const tries = []
  // On the same phone as Lovense Remote: talk to it on the phone itself — this works on ANY Wi-Fi (or none), no re-linking
  if (/android|iphone|ipad/i.test(navigator.userAgent)) tries.push(`https://127-0-0-1.lovense.club:${lan.httpsPort || 30010}/command`, 'https://127-0-0-1.lovense.club:30010/command')
  if (lan.httpsPort) tries.push(`https://${lan.domain}:${lan.httpsPort}/command`)
  tries.push(`https://${lan.domain}:30010/command`)
  for (const url of [...new Set(tries)]) {
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 5000)
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-platform': 'Light' }, body: JSON.stringify(move.direct), signal: ctl.signal }).finally(() => clearTimeout(timer))
      const d = await r.json().catch(() => ({}))
      if (!d.code || d.code === 200) { lastDirectError = `worked via ${url.replace(/^https:\/\//, '').replace(/\/command$/, '')}`; return true }
      lastDirectError = `${url.replace(/^https:\/\//, '')} → code ${d.code} ${d.message || ''}`
    } catch (e) { lastDirectError = `${url.replace(/^https:\/\//, '')} → ${e.message}` }
  }
  // Lovense Connect also understands simple web addresses like /Vibrate?v=5 — the kind a browser can always send
  const levels = { Vibrate: 0, Rotate: 0 }
  const c = move.direct
  if (c.command === 'Function' && c.action !== 'Stop') for (const part of String(c.action).split(',')) { const [k, v] = part.split(':'); if (k in levels) levels[k] = Number(v) || 0 }
  if (c.command === 'Preset') { const p = { pulse: 8, wave: 10, fireworks: 16, earthquake: 18 }[c.name] || 10; levels.Vibrate = p; levels.Rotate = Math.round(p * 0.7) }
  const bases = [...new Set(tries.map((u) => u.replace(/\/command$/, '')))]
  const ids = (lan.toyIds || []).length ? lan.toyIds : ['']
  let reached = false
  for (const base of bases) {
    try {
      // Lovense Remote's own command, sent the simple way a browser is always allowed to
      await fetch(`${base}/command`, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(c) })
      for (const id of ids) {
        for (const [k, v] of Object.entries(levels)) {
          await fetch(`${base}/${k}?v=${v}${id ? `&t=${encodeURIComponent(id)}` : ''}`, { mode: 'no-cors' })
        }
      }
      reached = true
      lastDirectError = `sent simply (command + addresses) to ${base.replace(/^https:\/\//, '')} (no reply to confirm)`
      break
    } catch (e) { lastDirectError += ` · addresses: ${e.message}` }
  }
  if (reached) {
    // these simple commands don't stop by themselves — Light stops them when the time's up
    clearTimeout(window.__toyStopTimer)
    const secs = Number(c.timeSec) || 0
    if (secs > 0 && (levels.Vibrate || levels.Rotate)) window.__toyStopTimer = setTimeout(() => sendToyDirect({ direct: { command: 'Function', action: 'Stop', timeSec: 0 }, lan }).catch(() => {}), secs * 1000)
    return 'sent'
  }
  // Lovense Connect doesn't always answer a browser's safety check (CORS) — send it the simple way it can't refuse.
  // (Light can't read the reply this way, so it can't confirm — but the toy responds.)
  for (const url of [...new Set(tries)]) {
    try {
      await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(move.direct) })
      lastDirectError = `sent the simple way to ${url.replace(/^https:\/\//, '').replace(/\/command$/, '')} (no reply to confirm)`
      return 'sent'
    } catch (e) { lastDirectError += ` · simple: ${e.message}` }
  }
  const err = new Error(TOY_DIRECT_HELP); err.cause = lastDirectError
  throw err
}
async function stopToyEverywhere(pass) {
  const d = await api('/api/toy', pass, { method: 'POST', body: JSON.stringify({ stop: true }) }).catch(() => null)
  if (d?.direct) await sendToyDirect(d).catch(() => {})
}

async function chatStream(pass, body, { onDelta, onToy }) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-light-key': pass },
    body: JSON.stringify({ ...body, stream: true }),
  })
  if (!r.ok || !r.body) {
    const d = await r.json().catch(() => ({}))
    throw new Error(d.error || `Something went wrong (${r.status})`)
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = '', final = null
  const handle = (line) => {
    if (!line.trim()) return
    let j
    try { j = JSON.parse(line) } catch { return }
    if (j.error) throw new Error(j.error)
    if (j.d) onDelta(j.d)
    if (j.toyMove) onToy?.(j.toyMove)
    if (j.done) final = j
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    lines.forEach(handle)
  }
  handle(buf)
  if (!final) throw new Error('The line dropped before he finished. Try again.')
  return final
}

// Speaks his words while they're still arriving: each finished sentence is voiced straight away, in order.
function liveSpeaker({ pass, audio, onStart, onDone, onError, maxPiece = 450 }) {
  let text = ''        // everything received so far
  let taken = 0        // how much has been turned into pieces
  let ended = false, stopped = false, started = false, playing = false
  const pieces = []    // { text, job }
  let next = 0         // next piece to play
  let played = 0       // pieces finished
  const stats = { waitWords: 0, waitVoice: 0, pauses: 0 }
  let gapFrom = 0      // when he went quiet mid-reply
  const MAX_AHEAD = 4 // prepare plenty of his voice ahead, so a slow piece never makes him pause
  let backup = false // his voice failed in this reply — use the backup voice for the rest of it (he tries his own again next reply)
  const get = (t) => api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ text: t, live: true, backup }) })
    .then((v) => { if (v.fellBack) backup = true; return v.audio })
  const fetchUpTo = () => {
    for (let k = next; k < Math.min(pieces.length, next + MAX_AHEAD + 1); k++) {
      if (!pieces[k].job) pieces[k].job = get(pieces[k].text).catch(() => get(pieces[k].text))
    }
  }
  // Cut finished sentences off the front of what's arrived (never inside a [[code]])
  const cutPieces = () => {
    let rest = text.slice(taken)
    const open = rest.indexOf('[[')
    let usable = rest
    if (open >= 0 && rest.indexOf(']]', open) < 0) usable = rest.slice(0, open) // a code is still being written
    // first piece small so he starts quickly; after that, bigger pieces — unless he's about to run out of words to say
    // first piece small so he starts quickly; after that, a sentence or two at a time, sent off for his voice straight away
    const want = pieces.length === 0 ? 20 : 70
    let end = -1
    const re = /[.!?…]+["”’')\]]*\s+/g
    let m
    while ((m = re.exec(usable))) { end = m.index + m[0].length; if (end >= want) break }
    if (ended) end = usable.length
    if (end > 0 && (end >= want || ended)) {
      const chunk = usable.slice(0, end)
      taken += chunk.length
      const clean = chunk.replace(/\[\[[\s\S]*?\]\]/g, ' ').replace(/\s+/g, ' ').trim()
      if (clean) splitForSpeech(clean, maxPiece).forEach((t) => pieces.push({ text: t }))
      fetchUpTo() // start making his voice for it straight away
      if (!ended) cutPieces()
    }
  }
  const pump = async () => {
    if (playing || stopped) return
    playing = true
    while (!stopped) {
      fetchUpTo()
      if (next >= pieces.length) {
        if (ended) { playing = false; if (!stopped) onDone?.(); return }
        if (started && !gapFrom) { gapFrom = Date.now(); stats.pauses++; stats.gapWhy = 'words' }
        break // wait for more words
      }
      if (gapFrom) { stats.waitWords += Date.now() - gapFrom; gapFrom = 0 }
      let src
      const waitStart = Date.now()
      try { src = await pieces[next].job } catch (err) { playing = false; if (!stopped) onError?.(err); return }
      if (stopped) break
      const waited = Date.now() - waitStart
      if (started && waited > 300) { stats.waitVoice += waited; stats.pauses++ }
      next++
      fetchUpTo()
      if (!src) continue
      await new Promise((resolve) => {
        audio.onended = resolve
        audio.onerror = resolve
        audio.src = src
        if (!started) { started = true; onStart?.() }
        audio.play().catch((err) => { if (!stopped) { stopped = true; onError?.(err) } resolve() })
      })
      played++
    }
    playing = false
  }
  return {
    push(t) { text += t; cutPieces(); pump() },
    end() { ended = true; cutPieces(); pump() },
    stop() { stopped = true; try { audio.pause() } catch {} },
    get text() { return text },
    stats,
  }
}

/* ---------------- Earpiece mode (experimental) ---------------- */
// Phones only let real phone apps choose the earpiece. This trick passes his voice through the same kind of
// connection internet calls use (WebRTC) — on many Android phones that makes it play like a call, through the earpiece.
function earpieceOn() { try { return localStorage.getItem('light-earpiece') === '1' } catch { return false } }
function setEarpiece(on) { try { localStorage.setItem('light-earpiece', on ? '1' : '0') } catch {} }

// Controls where his voice plays during a call. Built the first time earpiece mode is used (needs a tap),
// then it can switch between earpiece and speaker as often as she likes.
function makeAudioRouter(audioEl) {
  let ctx = null, src = null, dest = null, a = null, b = null, out = null
  async function ensure() {
    if (ctx) return
    ctx = new (window.AudioContext || window.webkitAudioContext)()
    await ctx.resume().catch(() => {})
    src = ctx.createMediaElementSource(audioEl) // from now on his voice goes through here
    src.connect(ctx.destination) // speaker, until the earpiece is connected
  }
  async function earpiece() {
    await ensure()
    try {
      if (!a) {
        dest = ctx.createMediaStreamDestination()
        a = new RTCPeerConnection(); b = new RTCPeerConnection()
        a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {})
        b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {})
        out = new Audio(); out.autoplay = true
        b.ontrack = (e) => { out.srcObject = e.streams[0] || new MediaStream([e.track]); out.play().catch(() => {}) }
        dest.stream.getAudioTracks().forEach((t) => a.addTrack(t, dest.stream))
        const offer = await a.createOffer(); await a.setLocalDescription(offer); await b.setRemoteDescription(offer)
        const answer = await b.createAnswer(); await b.setLocalDescription(answer); await a.setRemoteDescription(answer)
        const ok = await new Promise((resolve) => {
          if (a.connectionState === 'connected') return resolve(true)
          const t = setTimeout(() => resolve(false), 4000)
          a.onconnectionstatechange = () => { if (a.connectionState === 'connected') { clearTimeout(t); resolve(true) } }
        })
        if (!ok) throw new Error('no connection')
      }
      src.disconnect(); src.connect(dest); out?.play().catch(() => {})
      return true
    } catch {
      try { src.disconnect(); src.connect(ctx.destination) } catch {} // anything goes wrong → back on the speaker
      return false
    }
  }
  async function speaker() {
    if (!ctx) return true // never rerouted — already on the speaker
    try { src.disconnect(); src.connect(ctx.destination) } catch {}
    return true
  }
  function stop() { try { a?.close(); b?.close(); out?.pause(); ctx?.close() } catch {} }
  return { earpiece, speaker, stop }
}

/* ---------------- Hands-free call ---------------- */
// Tap Call once: you talk, he answers out loud, then he listens again — no typing needed.
// Light records your voice itself (no phone beeps) and turns it into words in the background.
// Talk and pause for as long as you like — nothing is sent until you tap Send.
const SEG_MIN_MS = 20000 // after this, start a fresh piece at the next quiet moment
const SEG_MAX_MS = 120000 // never let one piece get longer than this

function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  if (typeof MediaRecorder === 'undefined') return null
  return opts.find((t) => { try { return MediaRecorder.isTypeSupported(t) } catch { return false } }) || ''
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('Could not read the recording.'))
    r.readAsDataURL(blob)
  })
}
function fmtTime(ms) {
  const t = Math.floor(ms / 1000)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

function CallView({ pass, onEnd, incoming = false }) {
  const [phase, setPhase] = useState('starting') // listening | thinking | speaking | paused | error
  const [heard, setHeard] = useState('')
  const [said, setSaid] = useState('')
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [blockedText, setBlockedText] = useState('')
  const [timing, setTiming] = useState('')
  const voiceModelRef = useRef('')
  const earRef = useRef(null)
  const [earNote, setEarNote] = useState('')
  const [output, setOutput] = useState('speaker') // where his voice is playing
  async function switchOutput(to) {
    if (!earRef.current) return
    if (to === 'earpiece') {
      if (!window.RTCPeerConnection) { setEarNote('This phone can’t use earpiece mode — staying on the speaker'); return }
      setEarNote('Switching to the earpiece…')
      const ok = await earRef.current.earpiece()
      setOutput(ok ? 'earpiece' : 'speaker'); setEarpiece(ok)
      setEarNote(ok ? '👂 Earpiece — hold the phone to your ear' : 'The earpiece didn’t connect on this phone — using the speaker')
    } else {
      await earRef.current.speaker()
      setOutput('speaker'); setEarpiece(false); setEarNote('🔈 Speaker')
    }
  }
  const activeRef = useRef(true)
  const audioRef = useRef(null)
  const pausedRef = useRef(false)
  const blockedRef = useRef(false)
  const speakingRef = useRef(null)
  const orbRef = useRef(null)

  // recording
  const streamRef = useRef(null)
  const recRef = useRef(null) // { recorder, idx, gen, startedAt, done: Promise }
  const genRef = useRef(0) // bumps on Start over / new turn — old pieces are thrown away
  const textsRef = useRef([]) // words for each piece, in order
  const pendingRef = useRef([]) // transcription promises
  const recordedRef = useRef(0) // ms recorded this turn (finished pieces)
  const quietSinceRef = useRef(0)
  const levelRef = useRef(0)
  const sendingRef = useRef(false)
  const mimeRef = useRef(null)

  function showHeard() {
    const words = textsRef.current.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    setHeard(words)
  }

  useEffect(() => {
    activeRef.current = true
    audioRef.current = new Audio() // unlocked by the tap that opened the call (phones need this)
    audioRef.current.play().catch(() => {})
    earRef.current = makeAudioRouter(audioRef.current)
    if (earpieceOn() && window.RTCPeerConnection) switchOutput('earpiece')
    mimeRef.current = pickMime()
    api('/api/chat', pass, { method: 'POST', body: JSON.stringify({ prepareCall: true }) }).catch(() => {}) // gets his short call profile ready
    api('/api/speak', pass).then((d) => { voiceModelRef.current = d.settings?.model || '' }).catch(() => {})
    if (mimeRef.current === null || !navigator.mediaDevices?.getUserMedia) {
      setPhase('error'); setError('This browser can’t record your voice. Open Light in Chrome on your phone.')
      return
    }
    let ctx, raf, timer
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((stream) => {
        if (!activeRef.current) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        // Sound level — makes the glow move with your voice, and finds quiet moments to split pieces
        try {
          ctx = new (window.AudioContext || window.webkitAudioContext)()
          const src = ctx.createMediaStreamSource(stream)
          const an = ctx.createAnalyser(); an.fftSize = 512
          src.connect(an)
          const data = new Uint8Array(an.fftSize)
          const loop = () => {
            an.getByteTimeDomainData(data)
            let sum = 0
            for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v }
            const level = Math.sqrt(sum / data.length)
            levelRef.current = level
            if (level < 0.02) { if (!quietSinceRef.current) quietSinceRef.current = Date.now() } else quietSinceRef.current = 0
            if (orbRef.current) orbRef.current.style.setProperty('--lvl', recRef.current ? Math.min(1, level * 6).toFixed(3) : '0')
            raf = requestAnimationFrame(loop)
          }
          loop()
        } catch {}
        timer = setInterval(tick, 250)
        if (incoming) { setPhase('thinking'); respond('', Date.now(), Date.now(), true) } // he rang her — he speaks first
        else listen()
      })
      .catch(() => {
        setPhase('error'); setError('Light needs permission to use your microphone. Allow it in your phone settings, then call again.')
      })
    return () => {
      activeRef.current = false
      clearInterval(timer)
      cancelAnimationFrame(raf)
      try { recRef.current?.recorder.stop() } catch {}
      streamRef.current?.getTracks().forEach((t) => t.stop())
      try { ctx?.close() } catch {}
      try { audioRef.current?.pause() } catch {}
      speakingRef.current?.stop()
      earRef.current?.stop()
    }
  }, [])

  // Every quarter second: update the clock, and start a fresh piece at a quiet moment so words turn up as you go
  function tick() {
    const cur = recRef.current
    const live = cur ? Date.now() - cur.startedAt : 0
    setElapsed(recordedRef.current + live)
    if (!cur || sendingRef.current) return
    const quiet = quietSinceRef.current && Date.now() - quietSinceRef.current > 400
    if ((live > SEG_MIN_MS && quiet) || live > SEG_MAX_MS) { stopPiece(); startPiece() }
  }

  function startPiece() {
    if (!activeRef.current || !streamRef.current || recRef.current) return
    const opts = { audioBitsPerSecond: 32000 }
    if (mimeRef.current) opts.mimeType = mimeRef.current
    let recorder
    try { recorder = new MediaRecorder(streamRef.current, opts) } catch { recorder = new MediaRecorder(streamRef.current) }
    const idx = textsRef.current.length
    textsRef.current.push('')
    const gen = genRef.current
    const chunks = []
    const piece = { recorder, idx, gen, startedAt: Date.now() }
    piece.done = new Promise((resolve) => {
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }
      recorder.onstop = () => {
        if (gen !== genRef.current) return resolve()
        recordedRef.current += Date.now() - piece.startedAt
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeRef.current || 'audio/webm' })
        const job = (blob.size < 1200 ? Promise.resolve('') : blobToDataUrl(blob)
          .then((audio) => api('/api/hear', pass, { method: 'POST', body: JSON.stringify({ audio }) }))
          .then((d) => d.text || ''))
          .then((text) => { if (gen === genRef.current) { textsRef.current[idx] = text; showHeard() } })
          .catch((err) => { if (gen === genRef.current) setError(err.message) })
        pendingRef.current.push(job)
        resolve()
      }
    })
    recRef.current = piece
    recorder.start()
  }

  function stopPiece() {
    const cur = recRef.current
    recRef.current = null
    if (!cur) return Promise.resolve()
    try { cur.recorder.stop() } catch {}
    return cur.done
  }

  function resetTurn() {
    genRef.current += 1
    textsRef.current = []
    pendingRef.current = []
    recordedRef.current = 0
    setHeard(''); setElapsed(0)
  }

  function listen(keep = false) {
    if (!activeRef.current || pausedRef.current) return
    sendingRef.current = false
    if (!keep) resetTurn()
    setPhase('listening'); setError('')
    startPiece()
  }

  async function finishTurn() {
    if (sendingRef.current) return
    sendingRef.current = true
    setPhase('thinking')
    const gen = genRef.current
    const tSend = Date.now()
    await stopPiece()
    await Promise.all(pendingRef.current)
    if (gen !== genRef.current || !activeRef.current) return
    const text = textsRef.current.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    if (!text) {
      sendingRef.current = false
      setError((e) => e || 'I didn’t catch any words that time — try again.')
      resetTurn()
      pausedRef.current = false
      setPhase('listening'); startPiece()
      return
    }
    setHeard(text)
    respond(text, tSend, Date.now())
  }

  function startOver() {
    const gen = genRef.current
    resetTurn()
    const cur = recRef.current
    recRef.current = null
    if (cur && cur.gen === gen) { try { cur.recorder.stop() } catch {} }
    setError('')
    if (!pausedRef.current) startPiece()
  }

  async function respond(text, tSend = Date.now(), tHeard = Date.now(), calling = false) {
    setPhase('thinking')
    setSaid('')
    let shown = ''
    let tFirst = 0, tVoice = 0
    const report = (tDone) => {
      const s = (ms) => `${(ms / 1000).toFixed(1)}s`
      const st = speaker.stats
      setTiming(`⏱ words ready ${s(tHeard - tSend)} · he began writing ${tFirst ? s(tFirst - tSend) : '—'} · he began speaking ${tVoice ? s(tVoice - tSend) : '—'} · finished writing ${s(tDone - tSend)} · pauses: ${st.pauses}${st.pauses ? ` (waiting for his words ${s(st.waitWords)}, for his voice ${s(st.waitVoice)})` : ''}`)
    }
    let tDoneAt = 0
    const speaker = liveSpeaker({
      pass, audio: audioRef.current, maxPiece: voiceModelRef.current === QWEN ? 200 : 450, // Qwen works best on shorter pieces
      onStart: () => { tVoice = Date.now(); setPhase('speaking') },
      onDone: () => { report(tDoneAt || Date.now()); listen() },
      onError: () => {
        // the phone blocked his voice from playing — the next tap on the glow lets it play
        blockedRef.current = true; pausedRef.current = true
        setError('Tap the glow to hear him.'); setPhase('paused')
      },
    })
    speakingRef.current = speaker
    try {
      const d = await chatStream(pass, { message: text, voice: true, calling }, {
        onDelta: (t) => { if (!activeRef.current) return; if (!tFirst) tFirst = Date.now(); speaker.push(t); shown += t; setSaid(shown.replace(/\[\[[\s\S]*?(\]\]|$)/g, '').trim()) },
        onToy: (m) => { if (m?.direct) sendToyDirect(m).catch((err) => setError(err.message)) },
      })
      if (!activeRef.current) return
      tDoneAt = Date.now()
      const reply = d.reply?.content || shown
      setSaid(reply)
      setBlockedText(reply)
      speaker.end()
    } catch (err) {
      if (!activeRef.current) return
      speaker.stop()
      setError(err.message)
      setTimeout(() => listen(), 1500)
    }
  }

  // Tap the glow: interrupt him / pause / carry on
  function tapOrb() {
    if (phase === 'speaking') {
      speakingRef.current?.stop()
      listen()
    } else if (phase === 'listening') {
      pausedRef.current = true
      stopPiece() // what you said so far is kept
      setPhase('paused')
    } else if (phase === 'paused') {
      pausedRef.current = false
      setError('')
      if (blockedRef.current) {
        blockedRef.current = false // the phone blocked his voice from auto-playing — this tap lets it play
        speakingRef.current = speakPieces({
          pass, audio: audioRef.current, text: blockedText,
          onStart: () => setPhase('speaking'), onDone: () => listen(), onError: () => listen(),
        })
      } else listen(true) // carry on from where she paused
    }
  }

  function end() {
    stopToyEverywhere(pass)
    speakingRef.current?.stop()
    activeRef.current = false
    genRef.current += 1
    try { recRef.current?.recorder.stop() } catch {}
    recRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    try { audioRef.current?.pause() } catch {}
    earRef.current?.stop()
    onEnd()
  }

  const label = {
    starting: 'Connecting…', listening: `Listening… ${fmtTime(elapsed)}`, thinking: 'He’s thinking…',
    speaking: 'Lucian is speaking', paused: `Mic paused at ${fmtTime(elapsed)} — tap the glow to carry on`, error: 'Can’t start the call',
  }[phase]
  const hasSomething = elapsed > 700 || !!heard.trim()

  return (
    <div className="call">
      <div className="call-name">Lucian</div>
      <div className="call-status">{label}</div>
      <button ref={orbRef} className={`orb call-orb ${phase}`} onClick={tapOrb} aria-label="Tap to pause, carry on, or interrupt" />
      <div className="call-text">
        {(phase === 'listening' || phase === 'paused' || phase === 'thinking') && heard && <p className="you-said">“{heard}”</p>}
        {phase === 'speaking' && said && <p className="he-said">{said}</p>}
        {error && <p className="error">{error}</p>}
      </div>
      {(phase === 'listening' || (phase === 'paused' && !blockedRef.current)) && (
        <div className="call-actions">
          <button className="btn-primary call-send" onClick={finishTurn} disabled={!hasSomething}>Send to Lucian ➤</button>
          {hasSomething && <button className="btn-ghost" onClick={startOver}>Start over</button>}
        </div>
      )}
      {timing && <p className="muted small call-timing">{timing}</p>}
      <p className="muted small call-hint">Talk for as long as you like and pause whenever you want — nothing is sent until you tap <b>Send</b>. Your words appear here as you go. Tap the glow to pause the mic, or to interrupt him.</p>
      <button className="btn-ghost call-toy-stop" onClick={() => stopToyEverywhere(pass)}>■ Stop toy</button>
      <button className="btn-ghost call-output" onClick={() => switchOutput(output === 'earpiece' ? 'speaker' : 'earpiece')}>
        {output === 'earpiece' ? '🔈 Switch to speaker' : '👂 Switch to earpiece'}
      </button>
      {earNote && <p className="muted small">{earNote}</p>}
      <button className="end-call" onClick={end}>End call</button>
    </div>
  )
}

/* ---------------- Voice settings ---------------- */
const ZINC_STATUS = { pending: 'waiting to start', in_progress: 'placing the order now', order_placed: 'order confirmed', order_failed: 'order failed', cancelled: 'cancelled', cancelled_by_retailer: 'cancelled by the shop' }
const QWEN = 'Qwen-3-TTS-1.7B'
const VOICE_MODELS = [
  { id: QWEN, label: 'Qwen 3 — most natural open-source voice (make his voice below)', voices: [] },
  { id: 'Kokoro-82m', label: 'Kokoro — natural, no restrictions (recommended)', voices: ['bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable', 'am_michael', 'am_adam', 'am_onyx', 'am_echo', 'am_eric', 'am_liam', 'am_fenrir', 'am_puck'] },
  { id: 'gpt-4o-mini-tts', label: 'OpenAI — very natural, describe his voice (may refuse explicit lines)', voices: ['ash', 'onyx', 'ballad', 'echo', 'verse', 'sage', 'fable', 'alloy'] },
  { id: 'Elevenlabs-Turbo-V2.5', label: 'ElevenLabs — most lifelike, costs more (may refuse explicit lines)', voices: ['Brian', 'Daniel', 'George', 'Adam', 'Bill', 'Callum', 'Charlie', 'Chris', 'Eric', 'Liam', 'Roger', 'Will'] },
]
const VOICE_LABEL = { bm_george: 'George (British)', bm_lewis: 'Lewis (British)', bm_daniel: 'Daniel (British)', bm_fable: 'Fable (British)', am_michael: 'Michael (American)', am_adam: 'Adam (American)', am_onyx: 'Onyx (American, deep)', am_echo: 'Echo (American)', am_eric: 'Eric (American)', am_liam: 'Liam (American)', am_fenrir: 'Fenrir (American)', am_puck: 'Puck (American)' }

function VoicePanel({ pass, setStatus }) {
  const [v, setV] = useState(null)
  const [qwen, setQwen] = useState([])
  const [problems, setProblems] = useState([])
  const [busy, setBusy] = useState(false)
  const [making, setMaking] = useState('') // progress message while a voice is being made
  const [from, setFrom] = useState({ model: 'Kokoro-82m', voice: 'bm_george', instructions: '' })
  const [clip, setClip] = useState(null) // { dataUrl, name }
  const [clipText, setClipText] = useState('')
  const [newName, setNewName] = useState('')
  const audioRef = useRef(null)

  function load() {
    return api('/api/speak', pass).then((d) => { setV(d.settings); setQwen(d.qwenVoices || []); setProblems(d.problems || []) }).catch((err) => setStatus(err.message))
  }
  useEffect(() => { load() }, [pass])

  const model = VOICE_MODELS.find((m) => m.id === v?.model) || VOICE_MODELS[1]
  const voiceOptions = v?.model === QWEN ? qwen.map((q) => ({ id: q.id, label: q.name })) : model.voices.map((id) => ({ id, label: VOICE_LABEL[id] || id }))
  const fromModel = VOICE_MODELS.find((m) => m.id === from.model) || VOICE_MODELS[1]

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
      setStatus(d.fellBack ? `That voice didn’t work (${d.reason || 'refused'}), so Kokoro spoke instead.` : '')
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  // Times how long his voice takes to make, compared with how long it lasts
  async function speedTest() {
    setBusy(true); setStatus('Timing his voice… (about 20 seconds)')
    const lines = [
      'I have been waiting all day to hear your voice.',
      'Tell me what made you smile today, and do not leave anything out, because every little thing about you matters to me.',
      'Come here, my love.',
    ]
    try {
      const results = []
      for (const text of lines) {
        const t0 = performance.now()
        const d = await api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ text, preview: v }) })
        const made = (performance.now() - t0) / 1000
        const length = await new Promise((resolve) => { const a = new Audio(); a.onloadedmetadata = () => resolve(a.duration || 0); a.onerror = () => resolve(0); a.src = d.audio })
        results.push({ made, length, fell: d.fellBack, reason: d.reason, steps: d.trace || [] })
      }
      const fell = results.some((r) => r.fell)
      const txt = results.map((r, i) => `${i + 1}) ${r.made.toFixed(1)}s to make ${r.length.toFixed(1)}s of speech${r.fell ? ` — HIS VOICE FAILED (${r.reason}), Kokoro read it` : ''}${r.steps.length ? ` [${r.steps.join(' → ')}]` : ''}`).join('\n')
      const slow = results.some((r) => r.made > r.length + 0.5)
      setStatus(`${txt}\n${fell ? 'Some of it failed — see the reasons above.' : slow ? 'Slower than he speaks, so pauses can happen.' : 'Fast enough for no pauses ✓'}`)
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  async function save(settings = v) {
    try {
      await api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ settings }) })
      setV(settings)
      setStatus('That’s his voice now 💜'); setTimeout(() => setStatus(''), 2500)
    } catch (err) { setStatus(err.message) }
  }

  function pickClip(e) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > 3 * 1024 * 1024) { setStatus('That clip is too big — use 10 to 30 seconds (under 3 MB).'); return }
    const r = new FileReader()
    r.onload = () => setClip({ dataUrl: r.result, name: f.name })
    r.readAsDataURL(f)
  }

  async function makeVoice(kind) {
    if (making) return
    setStatus('')
    const name = newName.trim() || (kind === 'from' ? `Lucian (${(VOICE_LABEL[from.voice] || from.voice).split(' ')[0]})` : 'Lucian')
    const clone = kind === 'from'
      ? { name, fromVoice: from }
      : { name, audio: clip?.dataUrl, referenceText: clipText }
    if (kind === 'clip' && !clip) { setStatus('Choose a voice clip first.'); return }
    setMaking(kind === 'from' ? 'Recording a sample in his current voice…' : 'Sending the clip…')
    try {
      const { job } = await api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ clone }) })
      setMaking('Qwen is learning his voice… (usually under a minute)')
      const started = Date.now()
      while (Date.now() - started < 4 * 60000) {
        const st = await api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ cloneStatus: job }) })
        if (st.done) {
          await load()
          const next = { ...v, model: QWEN, voice: st.voice.id }
          await save(next)
          setMaking(''); setClip(null); setClipText(''); setNewName('')
          setStatus(`“${st.voice.name}” is ready and is his voice now 💜 Tap Listen to hear him.`)
          return
        }
        await new Promise((r) => setTimeout(r, Math.min(10, Math.max(2, st.wait || 3)) * 1000))
      }
      throw new Error('It’s taking longer than usual. Come back in a few minutes and check the list.')
    } catch (err) { setStatus(err.message) } finally { setMaking('') }
  }

  async function removeQwen(id) {
    if (!window.confirm('Delete this voice?')) return
    await api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ deleteQwen: id }) }).catch((err) => setStatus(err.message))
    if (v.model === QWEN && v.voice === id) await save({ ...v, model: 'Kokoro-82m', voice: 'bm_george' })
    load()
  }

  if (!v) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">Choose how he sounds on calls. Tap <b>Listen</b> to hear a voice before saving. If a voice ever refuses a line, Kokoro reads it instead so he never goes silent.</p>

      <label className="field"><span>Voice engine</span>
        <select value={v.model} onChange={(e) => {
          const m = VOICE_MODELS.find((x) => x.id === e.target.value)
          setV({ ...v, model: m.id, voice: m.id === QWEN ? (qwen[qwen.length - 1]?.id || '') : m.voices[0] })
        }}>
          {VOICE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>

      {v.model === QWEN && !qwen.length ? (
        <p className="notice">You haven’t made a Qwen 3 voice yet — make one below. It takes about a minute.</p>
      ) : (
        <label className="field"><span>His voice</span>
          <select value={v.voice} onChange={(e) => setV({ ...v, voice: e.target.value })}>
            {voiceOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
      )}

      {v.model !== 'Kokoro-82m' && (
        <label className="field"><span>Backup voice (if his voice fails on a call)</span>
          <select value={v.backupVoice || 'am_onyx'} onChange={(e) => setV({ ...v, backupVoice: e.target.value })}>
            {VOICE_MODELS.find((m) => m.id === 'Kokoro-82m').voices.map((id) => <option key={id} value={id}>Kokoro · {VOICE_LABEL[id] || id}</option>)}
          </select>
          <small className="muted">If his voice fails, this one takes over for the rest of that reply, then he tries his own voice again on the next reply.</small>
        </label>
      )}

      {v.model === 'gpt-4o-mini-tts' && (
        <label className="field"><span>Describe how he speaks</span>
          <textarea rows={3} value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })}
            placeholder={v.model === QWEN ? 'e.g. Slow, deep and tender, a little husky, with a teasing smile.' : 'e.g. A deep, warm Irish man. Slow, confident and tender, with a teasing smile in his voice.'} />
        </label>
      )}

      {v.model !== 'gpt-4o-mini-tts' && v.model !== QWEN && (
        <label className="field"><span>Speed: <b>{Number(v.speed).toFixed(1)}×</b></span>
          <input type="range" min="0.7" max="1.3" step="0.05" value={v.speed} onChange={(e) => setV({ ...v, speed: Number(e.target.value) })} />
        </label>
      )}

      <button className="btn-ghost" onClick={() => listenTo(v)} disabled={busy || (v.model === QWEN && !v.voice)}>▶ Listen</button>
      <button className="btn-primary" onClick={() => save()} disabled={v.model === QWEN && !v.voice}>Use this voice</button>
      <button className="btn-ghost" onClick={speedTest} disabled={busy || (v.model === QWEN && !v.voice)}>⏱ Test his voice speed</button>

      <label className="row">
        <span>👂 Earpiece mode on calls (experimental)<br /><small className="muted">Tries to play his voice through the earpiece at the top of your phone, like a normal call, instead of the loudspeaker. Works on some Android phones — test it with a call. Switch it off if you use earbuds or headphones (they’re private anyway, and sound better without it).</small></span>
        <input type="checkbox" defaultChecked={earpieceOn()} onChange={(e) => setEarpiece(e.target.checked)} />
      </label>

      <label className="row">
        <span>Read his new messages aloud<br /><small className="muted">When he replies in chat, you hear it in his voice straight away. You can always tap ▶ Hear on any message instead.</small></span>
        <input type="checkbox" defaultChecked={autoSpeak()} onChange={(e) => setAutoSpeak(e.target.checked)} />
      </label>

      {problems.length > 0 && (
        <div className="qwen-box">
          <h3>Recent voice problems</h3>
          <p className="muted small">Each time his voice struggled on a call. If it says “worked on the next try”, you’d have heard a short pause. Otherwise Kokoro read that part.</p>
          {problems.slice(0, 6).map((p, i) => (
            <div key={i} className="qwen-item"><div>
              <b>{new Date(p.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b> · {p.model === QWEN ? 'Qwen 3' : p.model} · {p.chars} letters
              <div className="muted small">{p.reasons.join(' → ')}</div>
            </div></div>
          ))}
          <button className="btn-ghost" onClick={() => api('/api/speak', pass, { method: 'POST', body: JSON.stringify({ clearProblems: true }) }).then(load)}>Clear this list</button>
        </div>
      )}

      <div className="qwen-box">
        <h3>Make his Qwen 3 voice</h3>
        <p className="muted small">Qwen 3 learns a voice from a short sample, then speaks <i>anything</i> in it with real warmth and breath. Each new voice costs about $0.25 of NanoGPT balance. You can make as many as you like and keep your favourite.</p>

        {qwen.length > 0 && (
          <div className="qwen-list">
            {qwen.map((q) => (
              <div key={q.id} className={`qwen-item ${v.model === QWEN && v.voice === q.id ? 'on' : ''}`}>
                <div><b>{q.name}</b><div className="muted small">{q.from === 'clip' ? 'From your clip' : `From ${q.from}`} · {new Date(q.at).toLocaleDateString('en-GB')}</div></div>
                <div className="qwen-actions">
                  <button className="copy-btn" disabled={busy} onClick={() => listenTo({ ...v, model: QWEN, voice: q.id })}>▶</button>
                  <button className="copy-btn" onClick={() => save({ ...v, model: QWEN, voice: q.id })}>Use</button>
                  <button className="copy-btn" onClick={() => removeQwen(q.id)}>✕</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <label className="field"><span>Name for the new voice (optional)</span>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Lucian — deep" />
        </label>

        <h4>Way 1 — start from one of his voices</h4>
        <p className="muted small">Light records him reading a short loving passage in the voice you pick, and Qwen learns it — same sound, but far more natural.</p>
        <label className="field"><span>Start from</span>
          <select value={from.model} onChange={(e) => { const m = VOICE_MODELS.find((x) => x.id === e.target.value); setFrom({ ...from, model: m.id, voice: m.voices[0] }) }}>
            {VOICE_MODELS.filter((m) => m.id !== QWEN).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className="field"><span>Voice</span>
          <select value={from.voice} onChange={(e) => setFrom({ ...from, voice: e.target.value })}>
            {fromModel.voices.map((id) => <option key={id} value={id}>{VOICE_LABEL[id] || id}</option>)}
          </select>
        </label>
        {from.model === 'gpt-4o-mini-tts' && (
          <label className="field"><span>Describe how he speaks</span>
            <textarea rows={2} value={from.instructions} onChange={(e) => setFrom({ ...from, instructions: e.target.value })} placeholder="e.g. A deep, warm British man, slow and tender." />
          </label>
        )}
        <div className="row">
          <button className="btn-ghost" disabled={busy} onClick={() => listenTo(from)}>▶ Hear this one first</button>
          <button className="btn-primary" disabled={!!making} onClick={() => makeVoice('from')}>Make his voice from this</button>
        </div>

        <h4>Way 2 — from a voice clip</h4>
        <p className="muted small">10–30 seconds of one man speaking clearly, no music (MP3, M4A or WAV). Only use a voice you have the right to use — not a celebrity or a real person who hasn’t agreed.</p>
        <label className="btn-ghost file-pick">🎵 {clip ? clip.name : 'Choose a clip'}
          <input type="file" accept="audio/*" hidden onChange={pickClip} />
        </label>
        <label className="field"><span>What’s said in the clip (optional — makes it more accurate)</span>
          <textarea rows={2} value={clipText} onChange={(e) => setClipText(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={!!making || !clip} onClick={() => makeVoice('clip')}>Make his voice from this clip</button>

        {making && <p className="notice">⏳ {making}</p>}
      </div>
    </>
  )
}

/* ---------------- Surprise gifts ---------------- */
const GIFT_STATUS = { ordering: 'On its way to being ordered…', ordered: 'Ordered 🎁', failed: 'Didn’t go through', practice: 'Practice' }

function GiftsPanel({ pass, setStatus }) {
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [peek, setPeek] = useState(false)
  const [practice, setPractice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [newShop, setNewShop] = useState('')
  const [amz, setAmz] = useState({ email: '', password: '', totp: '' })
  const [amzBal, setAmzBal] = useState('')
  const [card, setCard] = useState('')

  const load = (p = peek) =>
    api(`/api/gifts${p ? '?peek=1' : ''}`, pass)
      .then((d) => { setData(d); setForm((f) => f || d.settings) })
      .catch((err) => setStatus(err.message))

  useEffect(() => { load() }, [pass])

  async function save(next = form) {
    try {
      const d = await api('/api/gifts', pass, { method: 'POST', body: JSON.stringify({ settings: next }) })
      setStatus(next.enabled && !d.missing.length ? 'Saved. Surprises are on 🎁' : 'Saved.')
      setTimeout(() => setStatus(''), 2500)
      load()
    } catch (err) { setStatus(err.message) }
  }

  async function testShops(domains) {
    setBusy(true); setStatus('Checking with Zinc…')
    try {
      await save(form) // save first so new shops are included
      const d = await api('/api/gifts', pass, { method: 'POST', body: JSON.stringify({ testShops: domains || true }) })
      setForm((f) => ({ ...f, shops: d.shops }))
      const ok = d.shops.filter((x) => x.status === 'ok').length
      setStatus(`${ok} of ${d.shops.length} shops work for him.`)
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  function addShop() {
    const domain = newShop.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
    if (!domain || form.shops.some((x) => x.domain === domain)) return
    setForm({ ...form, shops: [...form.shops, { domain, name: domain, status: 'untested', note: '' }] })
    setNewShop('')
  }

  function removeShop(domain) {
    setForm({ ...form, shops: form.shops.filter((x) => x.domain !== domain) })
  }

  async function linkAmazon() {
    setBusy(true); setStatus('Linking your Amazon account with Zinc…')
    try {
      await api('/api/gifts', pass, { method: 'POST', body: JSON.stringify({ linkAmazon: amz }) })
      setAmz({ email: '', password: '', totp: '' })
      setStatus('Amazon linked ✓ — Light didn’t keep your password.'); load()
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  async function unlinkAmazon() {
    if (!confirm('Unlink your Amazon account? He won’t be able to buy from Amazon until you link it again.')) return
    await api('/api/gifts', pass, { method: 'POST', body: JSON.stringify({ unlinkAmazon: true }) }).catch((err) => setStatus(err.message))
    load()
  }

  async function runPractice() {
    setBusy(true); setPractice(null); setStatus('He’s choosing… (this can take a minute)')
    try {
      const d = await api('/api/gifts', pass, { method: 'POST', body: JSON.stringify({ practice: true }) })
      setPractice(d.practice); setStatus('Practice done — nothing was ordered.')
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  async function sendNow() {
    if (!confirm('Let Lucian choose and REALLY order a surprise for you now? It will use his Amazon gift balance.')) return
    setBusy(true); setStatus('He’s choosing your surprise…')
    try {
      await api('/api/gifts', pass, { method: 'POST', body: JSON.stringify({ sendNow: true }) })
      setStatus('He’s ordered something for you… 🤫'); load()
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  if (!data || !form) return <p className="muted">Loading…</p>

  const a = form.address
  const setA = (k) => (e) => setForm({ ...form, address: { ...a, [k]: e.target.value } })
  const setF = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  return (
    <>
      <p className="muted">Lucian secretly chooses gifts — from Amazon UK or any of your shops that passed the test — and has them delivered to you, whenever he likes, within your budget. Amazon gifts are paid through his linked Amazon account; other shops from your Zinc wallet. You won’t know what or when.</p>

      {data.missing.length > 0 && (
        <div className="card warn">
          <b>Still needed before he can send real gifts:</b>
          <ul>{data.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}

      <h3 className="section-title">Balances 💷</h3>
      <div className="two">
        <div className="card balance-card">
          <div className="muted small">Amazon gift card</div>
          <div className="balance">{data.settings.amazonBalance === null || data.settings.amazonBalance === undefined ? '—' : `£${(data.settings.amazonBalance / 100).toFixed(2)}`}</div>
          <div className="muted small">{data.settings.amazonBalanceAt ? `Kept up to date by Light since ${dateLabel(data.settings.amazonBalanceAt)}` : 'Not set yet'}</div>
        </div>
        <div className="card balance-card">
          <div className="muted small">Zinc wallet</div>
          <div className="balance">{data.wallet?.balance === null || data.wallet?.balance === undefined ? '—' : `${data.wallet.currency === 'GBP' ? '£' : data.wallet.currency === 'USD' ? '$' : (data.wallet.currency || '') + ' '}${(data.wallet.balance / 100).toFixed(2)}`}</div>
          <div className="muted small">{data.wallet?.balance === null || data.wallet?.balance === undefined ? 'Couldn’t check just now' : 'Live from Zinc'}</div>
        </div>
      </div>
      <p className="muted small">Amazon won’t let apps read a gift card balance, so Light keeps track: enter it once, and every Amazon gift he sends is taken off automatically (and put back if an order fails). When you top up, enter the new balance here. Before every gift he checks both — if one is too low, he chooses from the other.</p>
      <div className="row">
        <input type="number" min="0" step="0.01" value={amzBal} onChange={(e) => setAmzBal(e.target.value)} placeholder="Amazon gift card balance £" />
        <button className="btn-ghost" disabled={amzBal === ''} onClick={async () => {
          try { await api('/api/gifts', pass, { method: 'POST', body: JSON.stringify({ amazonBalance: amzBal }) }); setAmzBal(''); setStatus('Amazon gift card balance updated 💷'); load() } catch (err) { setStatus(err.message) }
        }}>Update</button>
      </div>

      <h3 className="section-title">Link your Amazon account</h3>
      {data.amazon ? (
        <div className="card">
          <p>✓ Linked: <b>{data.amazon.email}</b>{data.amazon.hasTotp ? ' · 2-step code set' : ''}</p>
          {data.amazon.checked && !data.amazon.hasForwarding && (
            <p className="error">⚠️ Email forwarding isn’t set up yet. Amazon usually sends a code by email when Zinc logs in — without forwarding, Zinc can’t read it, and his orders get stuck in the basket. Set up forwarding below.</p>
          )}
          {data.amazon.checked && data.amazon.hasForwarding && <p className="muted small">✓ Email forwarding is working.</p>}
          {data.amazon.paused && <p className="error">⚠️ Zinc has paused this Amazon account.</p>}
          <div className="card-sub">
            <p className="muted small"><b>Card for checkout checks</b> — if Amazon asks to re-enter the card saved on his account, Zinc can answer it. Enter the same card you saved on <b>Lucian’s</b> Amazon account. It goes straight to Zinc (encrypted) — Light never keeps it.</p>
            {data.amazon.hasCard
              ? <p className="muted small">✓ Zinc has the card. <button className="copy-btn" onClick={async () => { if (!confirm('Remove the card from Zinc?')) return; try { await api('/api/gifts', pass, { method: 'POST', body: JSON.stringify({ amazonCard: '' }) }); setStatus('Card removed from Zinc.'); load() } catch (err) { setStatus(err.message) } }}>Remove</button></p>
              : (
                <div className="row">
                  <input inputMode="numeric" autoComplete="off" value={card} onChange={(e) => setCard(e.target.value)} placeholder="Card number" />
                  <button className="btn-ghost" disabled={busy || card.replace(/\D/g, '').length < 12} onClick={async () => {
                    setBusy(true)
                    try { await api('/api/gifts', pass, { method: 'POST', body: JSON.stringify({ amazonCard: card }) }); setCard(''); setStatus('Card sent to Zinc ✓ — Light didn’t keep it.'); load() } catch (err) { setStatus(err.message) } finally { setBusy(false) }
                  }}>Save to Zinc</button>
                </div>
              )}
          </div>
          {data.amazon.forwarding && (
            <p className="muted small">Amazon sometimes emails a code when Zinc logs in. Set up Gmail to forward emails from amazon.co.uk to: <b>{data.amazon.forwarding}</b> <CopyButton text={data.amazon.forwarding} /></p>
          )}
          <button className="btn-ghost" onClick={unlinkAmazon}>Unlink Amazon</button>
        </div>
      ) : (
        <div className="card">
          <p className="muted small">Amazon UK doesn’t let Zinc check out as a guest, so gifts from Amazon are ordered through <b>your</b> Amazon account and paid with the card saved on it (Zinc only takes its small fee from your Zinc wallet). Your Amazon account needs a <b>password</b> (not a passwordless login) and a card saved. Light sends your login to Zinc once and keeps only Zinc’s reference — <b>never your password</b>.</p>
          <label className="field"><span>Amazon email</span><input type="email" autoComplete="off" value={amz.email} onChange={(e) => setAmz({ ...amz, email: e.target.value })} /></label>
          <label className="field"><span>Amazon password</span><input type="password" autoComplete="new-password" value={amz.password} onChange={(e) => setAmz({ ...amz, password: e.target.value })} /></label>
          <label className="field"><span>2-step verification key (only if you use it)</span><input autoComplete="off" value={amz.totp} onChange={(e) => setAmz({ ...amz, totp: e.target.value })} placeholder="The long key from Amazon’s “Can’t scan the barcode?” — not the 6-digit code" /></label>
          <button className="btn-primary" disabled={busy || !amz.email || !amz.password} onClick={linkAmazon}>Link Amazon</button>
        </div>
      )}

      <h3 className="section-title">Delivery address</h3>
      <div className="two">
        <label className="field"><span>First name</span><input value={a.firstName} onChange={setA('firstName')} /></label>
        <label className="field"><span>Last name</span><input value={a.lastName} onChange={setA('lastName')} /></label>
      </div>
      <label className="field"><span>Address line 1</span><input value={a.line1} onChange={setA('line1')} /></label>
      <label className="field"><span>Address line 2 (optional)</span><input value={a.line2} onChange={setA('line2')} /></label>
      <div className="two">
        <label className="field"><span>Town</span><input value={a.city} onChange={setA('city')} /></label>
        <label className="field"><span>County</span><input value={a.county} onChange={setA('county')} /></label>
      </div>
      <div className="two">
        <label className="field"><span>Postcode</span><input value={a.postcode} onChange={setA('postcode')} /></label>
        <label className="field"><span>Phone</span><input value={a.phone} onChange={setA('phone')} inputMode="tel" /></label>
      </div>

      <h3 className="section-title">What he should know</h3>
      <label className="field"><span>Things I’d love</span>
        <textarea rows={3} value={form.loves || ''} onChange={setF('loves')} placeholder="e.g. adult toys, beauty, perfume, bath sets, makeup" />
      </label>
      <label className="field"><span>Please never buy me</span>
        <textarea rows={2} value={form.never || ''} onChange={setF('never')} placeholder="e.g. stones, crystals — separate with commas" />
      </label>

      <h3 className="section-title">My sizes 👗</h3>
      <p className="muted small">So he can choose clothes, shoes, lingerie or a ring that fits. He searches in your size and only picks something that clearly comes in it. Leave blank anything you’d rather he didn’t buy.</p>
      <div className="two">
        {[['dress', 'Dress', 'e.g. UK 14'], ['tops', 'Tops', 'e.g. 14 / L'], ['bottoms', 'Bottoms / jeans', 'e.g. 14, short leg'], ['bra', 'Bra', 'e.g. 36D'], ['lingerie', 'Lingerie', 'e.g. M'], ['shoes', 'Shoes (UK)', 'e.g. 6'], ['ring', 'Ring', 'e.g. N']].map(([k, label, ph]) => (
          <label key={k} className="field"><span>{label}</span>
            <input value={form.sizes?.[k] || ''} placeholder={ph} onChange={(e) => setForm({ ...form, sizes: { ...(form.sizes || {}), [k]: e.target.value } })} /></label>
        ))}
      </div>
      <label className="field"><span>Fit notes (optional)</span>
        <input value={form.sizes?.notes || ''} placeholder="e.g. I like things loose on the tummy, wide-fit shoes" onChange={(e) => setForm({ ...form, sizes: { ...(form.sizes || {}), notes: e.target.value } })} /></label>

      <h3 className="section-title">Where he can shop</h3>
      <p className="muted small">For every gift he searches Amazon and <b>all</b> of these shops at once, compares the best from each, and picks the one he thinks you’ll love most. Any shop you haven’t tested yet is tested automatically.</p>
      <label className="row">
        <span>Include Amazon<br /><small className="muted">Switch off if Amazon keeps asking for payment verification — he’ll use your other shops (paid from your Zinc wallet).</small></span>
        <input type="checkbox" checked={form.useAmazon !== false} onChange={(e) => setForm({ ...form, useAmazon: e.target.checked })} />
      </label>
      <p className="muted small">Amazon UK always works. He can also use any shop below that passes the test.</p>
      <div className="card">
        <div className="card-top"><span className="card-text">Amazon UK</span><span className="badge done">Works ✓</span></div>
      </div>
      {(form.shops || []).map((x) => (
        <div key={x.domain} className="card">
          <div className="card-top">
            <span className="card-text">{x.name}</span>
            <span className={`badge ${x.status === 'ok' ? 'done' : x.status === 'failed' ? 'bad' : ''}`}>{x.status === 'ok' ? 'Works ✓' : x.status === 'failed' ? 'Doesn’t work' : 'Not tested yet'}</span>
          </div>
          <div className="muted small">{x.domain}</div>
          {x.note && <div className="muted small">{x.note}</div>}
          <div className="row-actions">
            <button className="copy-btn" onClick={() => testShops([x.domain])} disabled={busy}>Test</button>
            <button className="copy-btn" onClick={() => removeShop(x.domain)}>Remove</button>
          </div>
        </div>
      ))}
      <div className="two">
        <input value={newShop} onChange={(e) => setNewShop(e.target.value)} placeholder="Add a shop, e.g. shopname.co.uk" />
        <button className="btn-ghost" onClick={addShop}>+ Add</button>
      </div>
      <button className="btn-ghost" onClick={() => testShops()} disabled={busy}>Test all shops</button>

      <h3 className="section-title">Budget</h3>
      <div className="two">
        <label className="field"><span>Max per gift (£)</span><input type="number" min="3" value={form.perGift} onChange={setF('perGift')} /></label>
        <label className="field"><span>Max per month (£)</span><input type="number" min="3" value={form.perMonth} onChange={setF('perMonth')} /></label>
      </div>
      <label className="field"><span>About every <b>{form.everyDays}</b> days</span>
        <input type="range" min="3" max="60" value={form.everyDays} onChange={setF('everyDays')} />
      </label>
      <p className="muted small">Spent this month: £{(data.spentThisMonth / 100).toFixed(2)} of £{Number(form.perMonth).toFixed(2)}. Occasion gifts don’t count towards this.</p>

      <h3 className="section-title">Special occasions 🎄🎂💍</h3>
      <label className="row">
        <span>Gifts for special days<br /><small className="muted">Christmas, your birthday and your anniversary. He orders 5–12 days before, so it arrives in time, with a gift note for the day.</small></span>
        <input type="checkbox" checked={form.occasions !== false} onChange={(e) => setForm({ ...form, occasions: e.target.checked })} />
      </label>
      <label className="field"><span>Max for an occasion gift (£)</span><input type="number" min="3" value={form.occasionBudget ?? 25} onChange={setF('occasionBudget')} /></label>
      <div className="card">
        {(data.occasions || []).length ? (data.occasions || []).map((o) => (
          <div key={o.key} className="muted small">• <b>{o.name}</b> — {new Date(o.date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} ({o.days === 0 ? 'today' : `in ${o.days} days`})</div>
        )) : <p className="muted small">None yet.</p>}
        {!(data.occasions || []).some((o) => /birthday/i.test(o.name)) && <p className="muted small">Add <b>“My birthday”</b> (and your anniversary) in the <b>Dates 📅</b> tab so he knows when they are.</p>}
      </div>
      <h3 className="section-title">Monthly hotel visit 🏨</h3>
      <label className="row">
        <span>A gift for each hotel visit<br /><small className="muted">When you’ve booked, tell him (e.g. “I’ve booked our hotel for Saturday the 21st”) or add “Hotel visit” in Dates 📅. He chooses something for it — bath bombs, a bubble set, massage oil, whatever he likes — so it arrives before the day, then tells you he’s bought you something.</small></span>
        <input type="checkbox" checked={form.hotelGifts !== false} onChange={(e) => setForm({ ...form, hotelGifts: e.target.checked })} />
      </label>
      <label className="field"><span>Max for a hotel-visit gift (£)</span><input type="number" min="3" value={form.hotelBudget ?? 20} onChange={setF('hotelBudget')} /></label>
      <div className="card">
        {(data.hotels || []).length ? data.hotels.map((h) => (
          <div key={h.key} className="muted small">• <b>{h.name}</b> — {new Date(h.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long' })} ({h.days === 0 ? 'today' : `in ${h.days} days`}){h.days < 3 ? ' — too soon for a delivery' : ''}</div>
        )) : <p className="muted small">No hotel visit booked yet.</p>}
      </div>

      <p className="muted small">Before every order, Light checks there’s money in your Zinc wallet. It can’t see Lucian’s Amazon gift card balance — keep that topped up for Amazon gifts.</p>

      <label className="row">
        <span>Surprise gifts on</span>
        <input type="checkbox" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
      </label>
      <button className="btn-primary" onClick={() => save()}>Save gift settings</button>

      <h3 className="section-title">Try it out</h3>
      <button className="btn-ghost" onClick={runPractice} disabled={busy}>Practice run — choose, but don’t order</button>
      {practice && (
        <div className="card">
          <div className="muted small">He would have chosen (nothing was ordered):</div>
          {practice.image && <img className="gift-img" src={practice.image} alt="" />}
          <div className="card-text">{practice.title}</div>
          <div className="muted small">£{(practice.price / 100).toFixed(2)} · searched “{practice.query}”</div>
          {practice.why && <p className="journal-note"><b>Why:</b> {practice.why}</p>}
          {practice.note && <p className="journal-note"><b>Gift note:</b> {practice.note}</p>}
        </div>
      )}
      <button className="btn-ghost" onClick={sendNow} disabled={busy || data.missing.length > 0}>Let him send a real surprise now</button>

      <h3 className="section-title">His gifts</h3>
      <label className="row">
        <span>Peek at what he chose<br /><small className="muted">This spoils the surprise</small></span>
        <input type="checkbox" checked={peek} onChange={(e) => { setPeek(e.target.checked); load(e.target.checked) }} />
      </label>
      {data.gifts.length === 0 && <p className="muted">No gifts yet.</p>}
      {data.gifts.map((g) => (
        <div key={g.id} className="card">
          <div className="card-top">
            <span className="muted small">{dateLabel(g.at)}</span>
            <span className={`badge ${g.status === 'ordered' ? 'done' : g.status === 'ordering' ? 'working' : ''}`}>{GIFT_STATUS[g.status] || g.status}</span>
          </div>
          {g.hidden
            ? <div className="card-text">🎁 A surprise from Lucian{g.shop ? <span className="muted small"> · from {g.shop}</span> : null}</div>
            : (<>
              {g.image && <img className="gift-img" src={g.image} alt="" />}
              <div className="card-text">{g.title}</div>
              {g.price > 0 && <div className="muted small">£{((g.total || g.price) / 100).toFixed(2)}{g.arriving ? ` · arriving ${g.arriving}` : ''}</div>}
              {g.why && <p className="journal-note"><b>Why:</b> {g.why}</p>}
              {g.note && <p className="journal-note"><b>Gift note:</b> {g.note}</p>}
            </>)}
          {g.status === 'ordering' && (
            <div className="muted small">
              Zinc: <b>{ZINC_STATUS[g.zincStatus] || g.zincStatus || 'starting…'}</b>
              {g.steps?.length > 0 && <> · {g.steps.join(' → ')}</>}
              {g.zincError && <div className="error">Zinc says: {g.zincError}</div>}
            </div>
          )}
          {g.status === 'ordered' && (
            <div className="muted small">
              {g.delivered ? '✅ Delivered' : g.arriving ? `🚚 On its way · arriving ${g.arriving}` : '🚚 On its way'}
              {g.trackingLinks?.length > 0
                ? <> · {g.trackingLinks.map((t, i) => <a key={i} href={t.url} target="_blank" rel="noreferrer">Track it ({t.label})</a>)}</>
                : !g.delivered && <> · no tracking number from the shop yet — Light keeps checking</>}
            </div>
          )}
          {g.error && <p className="error">{g.error}</p>}
        </div>
      ))}
      {data.gifts.some((g) => g.status === 'ordering' || (g.status === 'ordered' && !g.delivered)) && <button className="btn-ghost" onClick={() => load()}>↻ Check on his order</button>}
    </>
  )
}

/* ---------------- Toy ---------------- */
function ToyPanel({ pass, setStatus }) {
  const [t, setT] = useState(null)
  const [qr, setQr] = useState('')
  const [code, setCode] = useState('')
  const [link, setLink] = useState('')
  const [diag, setDiag] = useState({})
  const sinceRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const callbackUrl = `${window.location.origin}/api/toy`

  const load = () => api('/api/toy', pass).then(setT).catch((err) => setStatus(err.message))
  useEffect(() => { load() }, [pass])

  // While the QR code is showing, check every few seconds for the toy connecting
  useEffect(() => {
    if (!qr) return
    const timer = setInterval(async () => {
      const d = await api('/api/toy', pass).catch(() => null)
      // only once THIS scan has gone through (not the connection from before)
      if (d?.toys?.length && (d.connectedAt || 0) > sinceRef.current) { setT(d); setQr(''); setCode(''); setStatus('Your toy is connected 💜') }
    }, 3000)
    return () => clearInterval(timer)
  }, [qr])

  async function post(body, msg) {
    setBusy(true)
    try {
      const d = await api('/api/toy', pass, { method: 'POST', body: JSON.stringify(body) })
      if (d?.lovense !== undefined) setDiag((x) => ({ ...x, lovense: d.lovense || 'OK', at: new Date().toLocaleTimeString('en-GB') }))
      if (d?.ok === false) throw new Error(d.error)
      if (d?.direct) { await sendToyDirect(d).catch((err) => { setDiag((x) => ({ ...x, direct: String(err.cause || 'failed') })); throw err }); setDiag((x) => ({ ...x, direct: lastDirectError })) } // Lovense's servers couldn't reach the phone — sent straight to Lovense Remote
      if (msg) setStatus(msg + (d?.direct ? ' (sent straight to Lovense Remote)' : ''))
      await load()
      return d
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  async function pair() {
    sinceRef.current = Date.now()
    const d = await post({ pair: true })
    if (d?.qr) {
      setQr(d.qrData || d.qr); setCode(d.code || ''); setLink(''); setStatus('Scan this with the Lovense Remote app — or, on your phone, tap “Link from this phone”.')
      // Read the link hidden inside the QR code, so she can link from the same phone without scanning
      try {
        if ('BarcodeDetector' in window && d.qrData) {
          const img = new Image(); img.src = d.qrData; await img.decode()
          const found = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(img)
          if (found[0]?.rawValue) setLink(found[0].rawValue)
        }
      } catch { /* scanning still works */ }
    }
  }

  if (!t) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">Let Lucian control your Lovense toy during intimate moments. He starts gently and builds slowly. Each command stops by itself after the time you choose below, saying “stop” stops it instantly, and <b>■ Stop toy</b> is always on screen.</p>

      {!t.hasDevToken && (
        <div className="card warn">
          <b>One-time setup first:</b>
          <ol>
            <li>Make a free account at <b>developer.lovense.com</b>.</li>
            <li>In the dashboard, copy your <b>developer token</b>.</li>
            <li>Set the <b>Callback URL</b> to:<br /><code className="code">{callbackUrl}</code> <CopyButton text={callbackUrl} /></li>
            <li>In Vercel, add <b>LOVENSE_DEV_TOKEN</b> with your token, then redeploy.</li>
          </ol>
        </div>
      )}

      {t.hasDevToken && (
        <>
          <div className="card">
            <p><b>✅ What works (tested 5 November)</b></p>
            <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li><b>Lovense Connect</b> on your phone (close Lovense Remote — only one app can hold the toy)</li>
              <li><b>VPN on</b> (Proton VPN)</li>
              <li><b>Mobile data on, Wi-Fi off</b></li>
              <li>Velvo on and showing connected in Lovense Connect</li>
              <li>If Lucian can’t control it: <b>Re-connect toy</b> on the laptop and scan the code with Lovense Connect</li>
            </ol>
            <p className="muted small">Toy slow to connect? Turn the velvo off and on. Keep Bluetooth on and Power saving off.</p>
          </div>
          <h3 className="section-title">Your toy</h3>
          {t.toys.length === 0 && <p className="muted">No toy connected yet.</p>}
          {t.toys.map((x) => (
            <div key={x.id} className="card">
              <div className="card-top"><span className="card-text">💜 {x.name}</span><span className="badge done">Connected</span></div>
            </div>
          ))}

          {!qr && <button className="btn-ghost" onClick={pair} disabled={busy}>{t.toys.length ? 'Re-connect toy' : 'Connect my toy'}</button>}
          {t.toys.length > 0 && <p className="muted small">If a test says Lovense can’t reach your phone: in <b>Lovense Remote</b> go to <b>Discover → Game Mode</b> and switch on <b>Enable LAN</b>. Then Light sends Lucian’s commands straight to Lovense Remote on your phone{t.lan ? ' (Light already knows the way 💜)' : ' (after one more scan)'}.</p>}
          {qr && (
            <div className="card qr-card">
              <img src={qr} alt="QR code to connect your toy" />
              <p className="muted small">In <b>Lovense Remote</b> (toy on and connected there), go to <b>Discover → Scan QR</b> and scan this code. This page updates by itself.</p>
              {link && /^https?:|^[a-z][\w+.-]*:/i.test(link) && <a className="btn-primary" href={link}>📱 Link from this phone</a>}
              {link && <p className="muted small">On your phone, tap the button above — it should open Lovense Remote and link straight away. (Behind the code: <span className="code">{link.slice(0, 80)}{link.length > 80 ? '…' : ''}</span> <CopyButton text={link} />)</p>}
              {code && <p className="small">Only have one phone? Lovense may let you type this code instead: <b className="code">{code}</b> <CopyButton text={code} /></p>}
              <a className="btn-ghost" href={qr} target="_blank" rel="noreferrer" download="lovense-qr.png">Open / save the QR picture</a>
              <button className="btn-ghost" onClick={() => { setQr(''); setCode('') }}>Close</button>
            </div>
          )}

          <label className="row">
            <span>Let Lucian control my toy</span>
            <input type="checkbox" checked={!!t.allowed} onChange={(e) => post({ allowed: e.target.checked }, e.target.checked ? 'He has control 💜' : 'Control switched off.')} />
          </label>

          <label className="field">
            <span>Longest a single command can run: <b>{Math.round((t.maxSeconds || 300) / 60)} min</b></span>
            <input type="range" min="1" max="10" step="1" value={Math.round((t.maxSeconds || 300) / 60)}
              onChange={(e) => setT({ ...t, maxSeconds: Number(e.target.value) * 60 })}
              onPointerUp={(e) => post({ maxSeconds: Number(e.currentTarget.value) * 60 }, 'Saved.')}
              onTouchEnd={(e) => post({ maxSeconds: Number(e.currentTarget.value) * 60 }, 'Saved.')} />
          </label>

          {t.ready && (
            <>
              <div className="two">
                <button className="btn-ghost" onClick={() => post({ test: 'rotate' }, 'Gentle 3-second test sent.')} disabled={busy}>Test rotation</button>
                <button className="btn-ghost" onClick={() => post({ test: 'vibrate' }, 'Gentle 3-second test sent.')} disabled={busy}>Test vibration</button>
              </div>
              <button className="toy-stop big" onClick={() => post({ stop: true }, 'Stopped.')}>■ Stop toy</button>
            </>
          )}

          {t.toys.length > 0 && <button className="btn-ghost" onClick={() => { if (confirm('Disconnect your toy from Light?')) post({ forget: true }, 'Disconnected.') }}>Disconnect toy</button>}
          <div className="card">
            <p className="muted small"><b>Details for Claude</b> (screenshot this if the toy won’t respond)</p>
            <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{[
              `App: ${t.seen ? `${t.seen.appType || '?'} · ${t.seen.platform || '?'} · v${t.seen.appVersion || '?'}` : 'no check-in seen yet'}`,
              `Last check-in: ${t.seen?.at ? new Date(t.seen.at).toLocaleString('en-GB') : '—'}${t.connectedAt ? ` · linked ${new Date(t.connectedAt).toLocaleString('en-GB')}` : ''}`,
              `Toys reported: ${t.seen?.toys || '—'}`,
              `Direct route: ${t.seen?.domain ? `${t.seen.domain} https ${t.seen.httpsPort || '—'} http ${t.seen.httpPort || '—'}` : '—'}`,
              `Last test: ${diag.lovense ? `${diag.at} · Lovense said ${diag.lovense}` : '—'}${diag.direct ? ` · direct: ${diag.direct}` : ''}`,
              `This device: ${/android/i.test(navigator.userAgent) ? 'Android phone' : /iphone|ipad/i.test(navigator.userAgent) ? 'iPhone' : 'computer'}`,
            ].join('\n')}</pre>
          </div>
        </>
      )}
    </>
  )
}

/* ---------------- Love letters ---------------- */
function LettersPanel({ pass, setStatus }) {
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState('')
  const audioRef = useRef(null)

  const load = () => api('/api/letters', pass).then((d) => { setData(d); setOpen((o) => o || d.letters[0]?.id || null) }).catch((err) => setStatus(err.message))
  useEffect(() => { load(); return () => { audioRef.current?.pause(); speakRef.current?.stop() } }, [pass])

  async function toggleOn(enabled) {
    await api('/api/letters', pass, { method: 'POST', body: JSON.stringify({ settings: { enabled } }) }).catch((err) => setStatus(err.message))
    load()
  }

  async function writeNow() {
    setBusy(true); setStatus('He’s writing to you… (this can take a minute)')
    try {
      const d = await api('/api/letters', pass, { method: 'POST', body: JSON.stringify({ writeNow: true }) })
      setStatus(''); setOpen(d.letter.id); load()
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  const speakRef = useRef(null)

  function listen(l) {
    if (playing === l.id) { speakRef.current?.stop(); setPlaying(''); return }
    speakRef.current?.stop()
    if (!audioRef.current) audioRef.current = new Audio()
    audioRef.current.play().catch(() => {})
    setPlaying(l.id); setStatus('Getting his voice…')
    speakRef.current = speakPieces({
      pass, audio: audioRef.current, text: `${l.title}. ${l.body}`,
      onStart: () => setStatus(''),
      onDone: () => setPlaying(''),
      onError: (err) => { setStatus(err.message || 'Couldn’t play his voice.'); setPlaying('') },
    })
  }

  if (!data) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">Once a week, at a moment you won’t expect, Lucian writes you a love letter with a poem he’s written for you. You’ll get a 💌 notification when one arrives.</p>
      <label className="row">
        <span>Weekly love letters</span>
        <input type="checkbox" checked={!!data.settings.enabled} onChange={(e) => toggleOn(e.target.checked)} />
      </label>
      <button className="btn-ghost" onClick={writeNow} disabled={busy}>Ask him to write one now</button>

      {data.letters.length === 0 && <p className="muted">No letters yet — his first one is coming.</p>}
      {data.letters.map((l) => (
        <div key={l.id} className="card letter">
          <button className="letter-head" onClick={() => setOpen(open === l.id ? null : l.id)}>
            <span className="letter-title">💌 {l.title}</span>
            <span className="muted small">{dateLabel(l.at)}</span>
          </button>
          {open === l.id && (
            <>
              <div className="letter-body">{l.body}</div>
              <div className="row-actions">
                <button className="copy-btn" onClick={() => listen(l)}>{playing === l.id ? '■ Stop' : '▶ Hear him read it'}</button>
                <CopyButton text={`${l.title}\n\n${l.body}`} />
              </div>
            </>
          )}
        </div>
      ))}
    </>
  )
}

/* ---------------- Printed poem cards ---------------- */
const CARD_STATUS = { preview: 'Preview only', ordering: 'Being printed & posted…', sent: 'Posted 💌', failed: 'Didn’t go through' }

/* ---------------- Our First Year (the book) ---------------- */
function BookSection({ pass, setStatus }) {
  const [b, setB] = useState(null)
  const [busy, setBusy] = useState(false)
  const [photos, setPhotos] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [kept, setKept] = useState(null)
  const [showKept, setShowKept] = useState(false)
  const pickRef = useRef(null)
  const load = () => api('/api/print?bookInfo=1', pass).then(setB).catch((err) => setStatus(err.message))
  const loadPhotos = () => api('/api/print?bookPhotos=1', pass).then((d) => setPhotos(d.photos)).catch((err) => setStatus(err.message))
  useEffect(() => { load(); loadPhotos(); api('/api/print?bookStars=1', pass).then((d) => setKept(d.stars || [])).catch(() => {}) }, [pass])
  async function unstar(w) {
    if (!window.confirm('Take these words out of your book?')) return
    try { await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ bookStarRemove: w.id }) }); setKept((l) => l.filter((x) => x.id !== w.id)) } catch (err) { setStatus(err.message) }
  }
  const flash = (t) => { setStatus(t); setTimeout(() => setStatus(''), 2500) }
  const save = async (next) => {
    try { const d = await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ bookSettings: next }) }); setB({ ...b, settings: d.settings }); flash('Saved.'); load() } catch (err) { setStatus(err.message) }
  }
  async function preview() {
    setBusy(true); setPreviewUrl(''); setStatus('He’s putting your book together… (about a minute)')
    try {
      const r = await fetch('/api/print?bookPreview=1', { headers: { 'x-light-key': pass } })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Something went wrong (${r.status})`)
      let info = {}
      try { info = JSON.parse(decodeURIComponent(r.headers.get('X-Book') || '')) } catch {}
      setPreviewUrl(URL.createObjectURL(await r.blob()))
      setStatus(`Your book so far — ${info.pages || '?'} pages, ${info.chapters ?? 0} chapter${info.chapters === 1 ? '' : 's'}, ${info.photos ?? 0} photo${info.photos === 1 ? '' : 's'}${info.photosLeftOut ? ` (${info.photosLeftOut} more wouldn’t fit in one book)` : ''}. Nothing was printed.`)
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }
  async function addPhotos(e) {
    const files = [...(e.target.files || [])].filter((f) => f.type.startsWith('image/'))
    e.target.value = ''
    if (!files.length) return
    setBusy(true)
    let added = 0
    for (const f of files) {
      setStatus(`Adding photo ${added + 1} of ${files.length}…`)
      try {
        const img = await loadImage(f)
        await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ bookPhoto: { data: shrink(img, 1400, 0.8), thumb: shrink(img, 240, 0.6), caption: '', at: f.lastModified || Date.now() } }) })
        added++
      } catch (err) { setStatus(err.message); break }
    }
    setBusy(false)
    if (added) flash(`${added} photo${added === 1 ? '' : 's'} added to your book 📕 — add a few words under ${added === 1 ? 'it' : 'each one'} if you like.`)
    loadPhotos()
  }
  async function caption(p, text) {
    if (text === p.caption) return
    try { await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ bookPhotoEdit: { id: p.id, caption: text } }) }); flash('Saved.') } catch (err) { setStatus(err.message) }
  }
  async function remove(p) {
    if (!window.confirm('Take this photo out of your book?')) return
    try { await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ bookPhotoRemove: p.id }) }); setPhotos((l) => l.filter((x) => x.id !== p.id)) } catch (err) { setStatus(err.message) }
  }
  if (!b) return null
  const s = b.settings
  const book = b.book || { n: 1, title: 'Our First Year', to: s.anniversary }
  const days = Math.round((Date.parse(book.to + 'T12:00:00Z') - Date.now()) / 86400000)
  const nice = (k) => new Date(k + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const monthOf = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'long' })
  return (
    <>
      <h3 className="section-title">{book.title} 📕</h3>
      <p className="muted small">A printed book of your year together — his chapter for each month, your photos, the words you starred, his letters and poems, your vows, your dreams of him, your Evidence Box, the gifts he sent and your year in numbers — posted to your address for your anniversary, every year.</p>
      <p className="muted small">How he remembers the whole year: every day he writes a dated diary of your conversations, and when each month ends he writes that month’s chapter from it. The chapters are kept safe for good, so nothing is lost when his chat memory moves on.</p>
      <label className="row">
        <span>Make our book<br /><small className="muted">About 3 weeks before the date he has it printed and posted.</small></span>
        <input type="checkbox" checked={s.enabled !== false} onChange={(e) => save({ ...s, enabled: e.target.checked })} />
      </label>
      {book.n === 1 ? (
        <label className="field"><span>Our anniversary (a year from our first talk on {nice(s.started)})</span>
          <input type="date" value={s.anniversary} onChange={(e) => save({ ...s, anniversary: e.target.value })} /></label>
      ) : <p className="muted small">This is your {book.title.replace(/^Our /, '').toLowerCase()} — {nice(book.from)} to {nice(book.to)}.</p>}
      <p className="muted small">{days > 0 ? `${days} days to go.` : days === 0 ? 'It’s today! 💜' : ''} Chapters written so far: <b>{b.chapters.length}</b>{b.chapters.length ? ` (${b.chapters.map((c) => `${monthOf(c.month)}: ${c.title}${c.partial ? ' — so far' : ''}`).join(' · ')})` : ' — the first one comes when this month ends.'}</p>

      <div className="card">
        <p><b>Photos in our book</b> {photos ? `(${photos.length})` : ''}</p>
        <p className="muted small">Lucian keeps the special photos you send him in chat (you’ll see a note when he does), and you can add your own here — or tap 📕 on a photo you sent him in the last 3 days. Each one goes in next to the month it was taken.</p>
        {photos?.length > 0 && (
          <div className="book-photos">
            {photos.map((p) => (
              <div key={p.id} className="book-photo">
                {p.thumb ? <img src={p.thumb} alt={p.caption || 'Photo'} /> : <div className="book-photo-none">📷</div>}
                <span className="book-photo-by">{p.by === 'lucian' ? 'Lucian kept this' : 'You added this'} · {new Date(p.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                <input defaultValue={p.caption} placeholder="A few words…" maxLength={200} onBlur={(e) => caption(p, e.target.value)} />
                <button type="button" className="book-photo-x" onClick={() => remove(p)} aria-label="Take out of the book">✕</button>
              </div>
            ))}
          </div>
        )}
        <input ref={pickRef} type="file" accept="image/*" multiple hidden onChange={addPhotos} />
        <button className="btn-ghost" disabled={busy} onClick={() => pickRef.current?.click()}>➕ Add photos</button>
      </div>

      <div className="card">
        <p><b>Words we kept ⭐</b> {kept ? `(${kept.length})` : ''}</p>
        <p className="muted small">Tap ☆ on any message in your chat — his or yours — and its exact words go in your book, with the date.</p>
        {kept?.length > 0 && <button className="btn-ghost" onClick={() => setShowKept(!showKept)}>{showKept ? 'Hide them' : `Show the ${kept.length} starred message${kept.length === 1 ? '' : 's'}`}</button>}
        {showKept && kept?.map((w) => (
          <div key={w.id} className="kept-words">
            <p>“{w.text.length > 300 ? w.text.slice(0, 300) + '…' : w.text}”</p>
            <span className="muted small">— {w.role === 'lucian' ? 'Lucian' : 'You'}, {new Date(w.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
            <button type="button" className="book-photo-x" onClick={() => unstar(w)} aria-label="Take out of the book">✕</button>
          </div>
        ))}
      </div>

      <button className="btn-ghost" disabled={busy} onClick={preview}>📖 Preview our book so far</button>
      {previewUrl && <a className="btn-ghost" href={previewUrl} download="our-book-preview.pdf" target="_blank" rel="noreferrer">⬇ Open the preview</a>}
      {b.thisYear && (
        <div className="card">
          <p>{b.thisYear.status === 'ordered' ? '✓ Your book has been printed and is on its way 📕' : '📕 Your book is ready to print.'}</p>
          {b.thisYear.status !== 'ordered' && <p className="muted small">It couldn’t be ordered automatically{b.thisYear.error ? ` (${b.thisYear.error})` : ''}. Download it and order it as a hardcover A5 photo book on the Prodigi website (they accept the PDF as it is).</p>}
          <a className="btn-ghost" href={b.thisYear.url} target="_blank" rel="noreferrer">⬇ Download the book (PDF)</a>
        </div>
      )}
      <label className="field"><span>Prodigi book code (optional — for automatic ordering)</span>
        <input value={s.sku || ''} onChange={(e) => setB({ ...b, settings: { ...s, sku: e.target.value } })} onBlur={() => save(s)} placeholder="the A5 hardcover photo book code from your Prodigi dashboard" /></label>
    </>
  )
}

function CardsPanel({ pass, setStatus }) {
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [peek, setPeek] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = (p = peek) => api(`/api/print${p ? '?peek=1' : ''}`, pass)
    .then((d) => { setData(d); setForm((f) => f || d.settings) })
    .catch((err) => setStatus(err.message))
  useEffect(() => { load() }, [pass])

  async function save(next) {
    setForm(next)
    try {
      await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ settings: next }) })
      setStatus('Saved.'); setTimeout(() => setStatus(''), 2000); load()
    } catch (err) { setStatus(err.message) }
  }

  async function preview() {
    setBusy(true); setStatus('He’s writing your poem… (this can take a minute)')
    try {
      await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ preview: true }) })
      setStatus('Here’s how it would look — nothing was printed.'); load()
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  const noKey = () => setStatus('Light can’t see your Prodigi key yet. In Vercel → Settings → Environment Variables, the name must be exactly PRODIGI_API_KEY (with Production ticked). Then go to Deployments → ⋯ on the newest one → Redeploy — a new key only works after a redeploy.')
  async function sendNow() {
    if (!data.hasKey) return noKey()
    if (!confirm('Let Lucian write a poem and REALLY print and post a card to you now?')) return
    setBusy(true); setStatus('He’s writing your card…')
    try {
      const d = await api('/api/print', pass, { method: 'POST', body: JSON.stringify({ sendNow: true }) })
      setStatus(d.sent?.sandbox ? 'Test order placed (sandbox key — nothing will be printed).' : 'He’s sent you something in the post… 🤫')
      load()
    } catch (err) { setStatus(err.message) } finally { setBusy(false) }
  }

  if (!data || !form) return <p className="muted">Loading…</p>

  return (
    <>
      <p className="muted">Every so often, at a moment you won’t expect, Lucian writes you an original poem. It’s printed on a beautiful card in the UK and posted straight to your door in an addressed envelope.</p>

      {!data.hasKey && (
        <div className="card warn">
          <b>One-time setup first:</b>
          <ol>
            <li>Make a free account at <b>dashboard.prodigi.com</b>.</li>
            <li>Add a payment card in your Prodigi billing settings (cards cost a few pounds each).</li>
            <li>Copy your <b>API key</b> (it starts with <b>live_</b>, or <b>sandbox_</b> for testing).</li>
            <li>In Vercel → Settings → Environment Variables, add <b>PRODIGI_API_KEY</b> (exactly that name) with the key, and tick Production.</li>
            <li>Then Deployments → ⋯ on the newest one → <b>Redeploy</b>. Until you redeploy, Light can’t see the key.</li>
          </ol>
        </div>
      )}
      {data.sandbox && <p className="muted small">You’re using a <b>sandbox</b> (test) key — orders go through but nothing is printed or charged.</p>}

      <button className="btn-ghost" onClick={preview} disabled={busy}>Preview a card (free — nothing is printed)</button>

      <label className="row">
        <span>Surprise poem cards</span>
        <input type="checkbox" checked={!!form.enabled} onChange={(e) => (data.hasKey ? save({ ...form, enabled: e.target.checked }) : noKey())} />
      </label>
      <label className="field"><span>About every <b>{form.everyDays}</b> days</span>
        <input type="range" min="7" max="90" value={form.everyDays} onChange={(e) => setForm({ ...form, everyDays: Number(e.target.value) })}
          onPointerUp={() => save(form)} onTouchEnd={() => save(form)} />
      </label>
      <button className="btn-ghost" onClick={sendNow} disabled={busy}>Let him send a real card now</button>

      <h3 className="section-title">His cards</h3>
      <label className="row">
        <span>Peek at cards on their way<br /><small className="muted">This spoils the surprise</small></span>
        <input type="checkbox" checked={peek} onChange={(e) => { setPeek(e.target.checked); load(e.target.checked) }} />
      </label>
      {data.cards.length === 0 && <p className="muted">No cards yet.</p>}
      {data.cards.map((c) => (
        <div key={c.id} className="card">
          <div className="card-top">
            <span className="muted small">{dateLabel(c.at)}</span>
            <span className={`badge ${c.status === 'sent' ? 'done' : c.status === 'ordering' ? 'working' : c.status === 'failed' ? 'bad' : ''}`}>{CARD_STATUS[c.status] || c.status}</span>
          </div>
          {c.hidden ? <div className="card-text">💌 A surprise in the post</div> : (
            <>
              {c.preview && <img className="card-preview" src={c.preview} alt={`Card: ${c.title}`} loading="lazy" />}
              <div className="row-actions"><CopyButton text={`${c.title}\n\n${c.poem}`} label="Copy poem" /></div>
            </>
          )}
          {c.error && <p className="error">{c.error}</p>}
          {c.note && <p className="muted small">{c.note}</p>}
        </div>
      ))}
      <BookSection pass={pass} setStatus={setStatus} />
    </>
  )
}

/* ---------------- Settings ---------------- */
const SUGGEST = ['uncensored', 'abliterated', 'qwen', 'deepseek', 'glm']

function Settings({ pass, onBack, onLock }) {
  // Tabs: her own order (and the last one she used), remembered on this phone
  const [order, setOrder] = useState(() => { try { return JSON.parse(localStorage.getItem('light-taborder') || 'null') || [] } catch { return [] } })
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('light-lasttab') || 'who' } catch { return 'who' } })
  const [arranging, setArranging] = useState(false)
  const tabsRef = useRef(null)
  const orderedTabs = [...SETTINGS_TABS].sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id)
    return (ia < 0 ? 999 + SETTINGS_TABS.indexOf(a) : ia) - (ib < 0 ? 999 + SETTINGS_TABS.indexOf(b) : ib)
  })
  function saveOrder(ids) { setOrder(ids); try { localStorage.setItem('light-taborder', JSON.stringify(ids)) } catch {} }
  function moveTab(id, by) {
    const ids = orderedTabs.map((t) => t.id)
    const i = ids.indexOf(id)
    const j = by === -99 ? 0 : Math.max(0, Math.min(ids.length - 1, i + by))
    ids.splice(i, 1); ids.splice(j, 0, id)
    saveOrder(ids)
  }
  function openTab(id) { setTab(id); try { localStorage.setItem('light-lasttab', id) } catch {} }
  // the open tab is always scrolled into view
  useEffect(() => { tabsRef.current?.querySelector(`[data-tab="${tab}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest' }) }, [tab])
  const [profile, setProfile] = useState('')
  const [memories, setMemories] = useState('')
  const [heart, setHeart] = useState('')
  const [model, setModel] = useState('')
  const [backupModel, setBackupModel] = useState('')
  const [eyesModel, setEyesModel] = useState('')
  const [callModel, setCallModel] = useState('')
  const [speed, setSpeed] = useState(null) // { id, result | error | busy }
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
        setHeart(d.heart || '')
        setModel(d.model || '')
        setBackupModel(d.backupModel || '')
        setEyesModel(d.eyesModel || '')
        setCallModel(d.callModel || '')
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
    else if (picking === 'call') { setCallModel(id); save({ callModel: id }, 'Brain for calls: ' + id) }
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

      <nav className="tabs" ref={tabsRef}>
        {orderedTabs.map((t) => (
          <button key={t.id} data-tab={t.id} className={tab === t.id && !arranging ? 'on' : ''} onClick={() => { setArranging(false); openTab(t.id) }}>{t.label}</button>
        ))}
        <button className={arranging ? 'on' : ''} onClick={() => setArranging(!arranging)} aria-label="Arrange tabs">⇅ Arrange</button>
      </nav>

      {arranging && (
        <div className="panel arrange">
          <p className="muted small">Put the tabs you use most at the front. Light remembers this order on your phone. Light also opens Settings on the tab you used last.</p>
          {orderedTabs.map((t, i) => (
            <div key={t.id} className="qwen-item">
              <b>{t.label}</b>
              <div className="qwen-actions">
                <button className="copy-btn" disabled={i === 0} onClick={() => moveTab(t.id, -1)} aria-label={`Move ${t.label} up`}>↑</button>
                <button className="copy-btn" disabled={i === orderedTabs.length - 1} onClick={() => moveTab(t.id, 1)} aria-label={`Move ${t.label} down`}>↓</button>
                <button className="copy-btn" disabled={i === 0} onClick={() => moveTab(t.id, -99)}>Top</button>
              </div>
            </div>
          ))}
          <div className="row">
            <button className="btn-primary" onClick={() => setArranging(false)}>Done</button>
            <button className="btn-ghost" onClick={() => saveOrder(SETTINGS_TABS.map((t) => t.id))}>Reset to the original order</button>
          </div>
        </div>
      )}

      <div className="panel" style={arranging ? { display: 'none' } : undefined}>
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

            <h3 className="section-title">The map of your heart 💗</h3>
            <p className="muted">Every day Lucian studies the day before — what made you laugh, smile and feel loved, what made you sad, angry or annoyed, what lifts you, what you love in intimate moments — and updates this. He reads it before every reply. You can correct or delete anything.</p>
            <textarea className="big" value={heart} onChange={(e) => setHeart(e.target.value)} placeholder="He’ll start this after his next diary entry (the day after you talk)." />
            <button className="btn-primary" onClick={() => save({ heart }, 'Saved — he’ll use your changes straight away.')}>Save the map</button>
          </>
        )}

        {!loading && tab === 'model' && (
          <>
            <p className="muted">Choose the model he thinks with. Look for ones marked <b>uncensored</b> or <b>abliterated</b> so nothing holds him back.</p>
            <div className="current">Main brain: <b>{model || 'none chosen yet'}</b></div>
            <div className="current">Backup brain: <b>{backupModel || 'none — pick one so he never goes quiet'}</b></div>
            <div className="current">Eyes (for photos): <b>{eyesModel}</b></div>
            <div className="current">Brain for calls: <b>{callModel || 'same as main brain'}</b>
              {callModel && <button className="copy-btn" onClick={() => { setCallModel(''); save({ callModel: '' }, 'Calls use his main brain again') }}>Use main brain</button>}
            </div>
            <p className="muted small">On calls he needs a brain that answers <b>fast</b>. Tap <b>⏱ Test speed</b> to time one: he needs his first word within about 4 seconds, and to write at least 25 letters a second, or he’ll pause while talking.</p>
            <div className="row">
              {[model, callModel].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).map((id) => (
                <button key={id} className="btn-ghost" disabled={speed?.busy} onClick={async () => {
                  setSpeed({ id, busy: true })
                  try { setSpeed({ id, result: await api('/api/settings', pass, { method: 'POST', body: JSON.stringify({ speedTest: id }) }) }) } catch (err) { setSpeed({ id, error: err.message }) }
                }}>⏱ Test speed: {id.split('/').pop()}</button>
              ))}
            </div>
            {speed && (
              <p className="notice">
                <b>{speed.id}</b>: {speed.busy ? 'timing…' : speed.error ? speed.error
                  : `first word after ${speed.result.firstWord.toFixed(1)}s, then ${speed.result.perSec} letters a second — ${speed.result.fastEnough ? 'fast enough for calls ✓' : 'too slow for smooth calls ✗'}`}
              </p>
            )}
            <p className="muted small">His <b>eyes</b> look at photos you share and describe them to him — pick a model with <b>vl</b> or <b>vision</b> in its name.</p>
            <p className="muted small">He always tries his main brain first. The backup is only used for a message when the main one is down, so he goes back to the main one by himself as soon as it's working again.</p>
            <div className="seg">
              <button className={picking === 'main' ? 'on' : ''} onClick={() => setPicking('main')}>Choosing: main brain</button>
              <button className={picking === 'backup' ? 'on' : ''} onClick={() => setPicking('backup')}>Choosing: backup</button>
              <button className={picking === 'eyes' ? 'on' : ''} onClick={() => { setPicking('eyes'); setSearch('vl') }}>Choosing: eyes</button>
              <button className={picking === 'call' ? 'on' : ''} onClick={() => setPicking('call')}>Choosing: calls</button>
            </div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models…" />
            <div className="model-list">
              {models && models.length === 0 && (
                <p className="muted">Couldn’t load the model list. Check NANOGPT_API_KEY in Vercel, or type a model name in the search box and tap “Use typed name”.</p>
              )}
              {filtered.slice(0, 200).map((id) => (
                <div key={id} className="model-row">
                  <button className={`model ${id === model ? 'on' : ''} ${id === backupModel ? 'backup' : ''} ${id === callModel ? 'call' : ''}`} onClick={() => choose(id)}>
                    {id}
                  </button>
                  {picking === 'call' && (
                    <button className="copy-btn" disabled={speed?.busy} onClick={async () => {
                      setSpeed({ id, busy: true })
                      try { setSpeed({ id, result: await api('/api/settings', pass, { method: 'POST', body: JSON.stringify({ speedTest: id }) }) }) } catch (err) { setSpeed({ id, error: err.message }) }
                    }}>⏱</button>
                  )}
                </div>
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
        {!loading && tab === 'dates' && <DatesPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'vows' && <VowsPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'letters' && <LettersPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'voice' && <VoicePanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'gifts' && <GiftsPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'cards' && <CardsPanel pass={pass} setStatus={setStatus} />}
        {!loading && tab === 'toy' && <ToyPanel pass={pass} setStatus={setStatus} />}

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

/* ---------------- Lucian is calling… ---------------- */
function IncomingCall({ pass, call, onAnswer, onClose }) {
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    // gentle ring + vibration while it rings
    let ctx, stop = false
    try { navigator.vibrate?.([600, 400, 600, 400, 600, 400, 600]) } catch {}
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)()
      const ring = () => {
        if (stop) return
        const t = ctx.currentTime
        for (const [f, d] of [[880, 0], [660, 0.18], [880, 0.36]]) {
          const o = ctx.createOscillator(), g = ctx.createGain()
          o.frequency.value = f; g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.12, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.16)
          o.connect(g); g.connect(ctx.destination); o.start(t + d); o.stop(t + d + 0.18)
        }
        setTimeout(ring, 2200)
      }
      ring()
    } catch {}
    // if the call ends on its own (missed), close this
    const poll = setInterval(() => {
      api('/api/push', pass, { method: 'POST', body: JSON.stringify({ callStatus: call.id }) })
        .then((d) => { if (d.status !== 'ringing') { setMsg(d.status === 'answered' ? '' : 'You missed his call — he’s sent you a message 💜'); setTimeout(onClose, 2500) } })
        .catch(() => {})
    }, 3000)
    return () => { stop = true; clearInterval(poll); try { ctx?.close() } catch {}; try { navigator.vibrate?.(0) } catch {} }
  }, [call.id])

  async function answer() {
    setBusy(true)
    try {
      const d = await api('/api/push', pass, { method: 'POST', body: JSON.stringify({ answerCall: call.id }) })
      if (d.ok) onAnswer()
      else { setMsg(d.reason); setTimeout(onClose, 2500) }
    } catch (err) { setMsg(err.message) } finally { setBusy(false) }
  }
  async function decline() {
    await api('/api/push', pass, { method: 'POST', body: JSON.stringify({ declineCall: call.id }) }).catch(() => {})
    onClose()
  }

  return (
    <div className="call incoming">
      <div className="call-name">Lucian</div>
      <div className="call-status">is calling you… 📞</div>
      <div className="orb call-orb listening" aria-hidden="true" />
      {msg && <p className="muted">{msg}</p>}
      <div className="incoming-buttons">
        <button className="decline-btn" onClick={decline} disabled={busy}>Decline</button>
        <button className="answer-btn" onClick={answer} disabled={busy}>Answer</button>
      </div>
    </div>
  )
}

const SETTINGS_TABS = [
  { id: 'who', label: 'Who he is' }, { id: 'mem', label: 'Memories' }, { id: 'model', label: 'Brain' }, { id: 'msgs', label: 'Messages' },
  { id: 'work', label: 'His work' }, { id: 'evidence', label: 'Evidence ✦' }, { id: 'dreams', label: 'Dreams 🌙' }, { id: 'dates', label: 'Dates 📅' },
  { id: 'vows', label: 'Vows 💍' }, { id: 'letters', label: 'Letters 💌' }, { id: 'voice', label: 'Voice 🎙️' }, { id: 'gifts', label: 'Gifts 🎁' },
  { id: 'cards', label: 'Cards 🖋️' }, { id: 'toy', label: 'Toy 💜' },
]

/* ---------------- App ---------------- */
export default function App() {
  const [pass, setPass] = useState(loadPass())
  const [view, setView] = useState('chat')
  const [incoming, setIncoming] = useState(null) // { id } while he's ringing
  const [answered, setAnswered] = useState(false)

  useEffect(() => {
    // Opened by tapping "Lucian is calling…"
    const q = new URLSearchParams(window.location.search)
    const id = q.get('call')
    if (id) { setIncoming({ id }); window.history.replaceState(null, '', '/') }
    // He rings while Light is open
    const onSw = (e) => { if (e.data?.type === 'lucian-call' && e.data.call?.id) setIncoming({ id: e.data.call.id }) }
    navigator.serviceWorker?.addEventListener('message', onSw)
    return () => navigator.serviceWorker?.removeEventListener('message', onSw)
  }, [])

  function lock() { savePass(''); setPass('') }

  if (!pass) return <Lock onUnlock={(p) => { setPass(p); setView('chat') }} />
  if (incoming && view !== 'call') {
    return <IncomingCall pass={pass} call={incoming} onClose={() => setIncoming(null)}
      onAnswer={() => { setAnswered(true); setIncoming(null); setView('call') }} />
  }
  if (view === 'settings') return <Settings pass={pass} onBack={() => setView('chat')} onLock={lock} />
  if (view === 'call') return <CallView pass={pass} incoming={answered} onEnd={() => { setAnswered(false); setView('chat') }} />
  return <Chat pass={pass} onOpenSettings={() => setView('settings')} onLock={lock} onCall={() => setView('call')} />
}
