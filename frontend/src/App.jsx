import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const RATE = 20
const FACTOR = { mini: 1, pickup: 1.15, truck: 1.35, heavy: 1.7 }
const LABEL = {
  open: 'Finding a driver', accepted: 'Driver accepted', awaiting_loading: 'Waiting for loading verification',
  loading_verified: 'Load verified', in_transit: 'On the way', delivered: 'Delivery verification needed',
  completed: 'Completed', cancelled: 'Cancelled',
}

async function api(path, { token, ...options } = {}) {
  const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers }
  if (token) headers.Authorization = `******
  const response = await fetch(`${API}${path}`, { ...options, headers })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || 'Something went wrong. Please try again.')
  }
  return response.status === 204 ? null : response.json()
}

function MapView({ point }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!point || !ref.current) return undefined
    const map = L.map(ref.current, { scrollWheelZoom: false }).setView([point.latitude, point.longitude], 12)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map)
    L.marker([point.latitude, point.longitude]).addTo(map).bindPopup('Latest shared truck location')
    return () => map.remove()
  }, [point?.latitude, point?.longitude])
  return point ? <div ref={ref} className="map" aria-label="Map showing the latest truck location" /> :
    <div className="map-empty">The map appears when your driver shares a GPS location.</div>
}

function openDocsDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('trucklink-offline-documents', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('documents', { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error('Offline storage is unavailable on this device.'))
  })
}

function App() {
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trucklink-session') || 'null') } catch { return null }
  })
  const [page, setPage] = useState('home')
  const [bookings, setBookings] = useState([])
  const [selected, setSelected] = useState(null)
  const [profile, setProfile] = useState(null)
  const [location, setLocation] = useState(null)
  const [documents, setDocuments] = useState([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [installPrompt, setInstallPrompt] = useState(null)
  const token = session?.token

  const say = (text) => { setNotice(text); setError('') }
  const problem = (text) => { setError(text); setNotice('') }
  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const rows = await api('/api/bookings', { token })
      setBookings(rows)
      if (selected) setSelected(rows.find((row) => row.id === selected.id) || selected)
    } catch (issue) { problem(issue.message) }
  }, [token, selected?.id])

  useEffect(() => {
    const network = () => setOnline(navigator.onLine)
    const install = (event) => { event.preventDefault(); setInstallPrompt(event) }
    window.addEventListener('online', network)
    window.addEventListener('offline', network)
    window.addEventListener('beforeinstallprompt', install)
    if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js')
    return () => {
      window.removeEventListener('online', network)
      window.removeEventListener('offline', network)
      window.removeEventListener('beforeinstallprompt', install)
    }
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (!token) { setProfile(null); return }
    api('/api/auth/me', { token }).then(setProfile).catch((issue) => problem(issue.message))
  }, [token])
  useEffect(() => {
    if (!selected || !token) return
    api(`/api/bookings/${selected.id}/location`, { token }).then((result) => setLocation(result.location)).catch(() => setLocation(null))
    api(`/api/bookings/${selected.id}/documents`, { token }).then(setDocuments).catch(() => setDocuments([]))
  }, [selected?.id, token])

  const active = useMemo(() => bookings.filter((b) => !['completed', 'cancelled'].includes(b.status)), [bookings])
  const complete = useMemo(() => bookings.filter((b) => b.status === 'completed'), [bookings])
  const available = useMemo(() => bookings.filter((b) => b.status === 'open'), [bookings])
  const estimate = (km, type) => Math.max(500, Math.round(Number(km || 0) * RATE * FACTOR[type || 'truck']))
  const selectBooking = (booking) => { setSelected(booking); setPage('booking') }

  async function authenticate(event) {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(event.currentTarget))
    try {
      const result = await api(`/api/auth/${page === 'register' ? 'register' : 'login'}`, {
        method: 'POST', body: JSON.stringify({ ...data, ...(data.capacity_kg ? { capacity_kg: Number(data.capacity_kg) } : {}) }),
      })
      localStorage.setItem('trucklink-session', JSON.stringify(result))
      setSession(result)
      setPage('dashboard')
      say(`Welcome, ${result.user.name}!`)
    } catch (issue) { problem(issue.message) }
  }

  async function createBooking(event) {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(event.currentTarget))
    try {
      const result = await api('/api/bookings', {
        token, method: 'POST',
        body: JSON.stringify({ ...data, weight_kg: Number(data.weight_kg), distance_km: Number(data.distance_km) }),
      })
      await refresh()
      setSelected(result)
      setPage('booking')
      say(`Request created. Estimated fare: ₹${result.fare.toLocaleString('en-IN')}.`)
    } catch (issue) { problem(issue.message) }
  }

  async function perform(path, options = {}, message = 'Changes saved.') {
    try {
      const result = await api(path, { token, ...options })
      if (result?.demo_code) say(`${result.demo_label}. Code: ${result.demo_code}`)
      else say(message)
      await refresh()
      if (selected) setSelected(await api(`/api/bookings/${selected.id}`, { token }))
      return result
    } catch (issue) { problem(issue.message); return null }
  }

  async function accept(job) {
    const result = await perform(`/api/bookings/${job.id}/accept`, { method: 'POST' }, 'Job accepted. Coordinate loading verification with your customer.')
    if (result) { setSelected(result); setPage('booking') }
  }

  async function verify(event, booking, kind) {
    event.preventDefault()
    const code = new FormData(event.currentTarget).get('code')
    const result = await perform(`/api/bookings/${booking.id}/verify-otp`, {
      method: 'POST', body: JSON.stringify({ kind, code }),
    }, 'Code verified.')
    if (result) { setSelected(result); event.currentTarget.reset() }
  }

  async function issueCode(kind) {
    const result = await perform(`/api/bookings/${selected.id}/otp`, {
      method: 'POST', body: JSON.stringify({ kind }),
    }, 'Demo code created.')
    if (result?.demo_code) navigator.clipboard?.writeText(result.demo_code).catch(() => {})
  }

  async function shareLocation(booking) {
    if (!navigator.geolocation) { problem('This device does not support GPS location sharing.'); return }
    say('Waiting for GPS permission…')
    navigator.geolocation.getCurrentPosition(async (position) => {
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude }
      const result = await perform(`/api/bookings/${booking.id}/location`, { method: 'POST', body: JSON.stringify(point) }, 'Location shared with the customer.')
      if (result) setLocation(point)
    }, (issue) => problem(issue.code === 1
      ? 'Location permission was denied. Allow location access in your browser settings.'
      : 'GPS is unavailable. Try again outdoors with location enabled.'),
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 })
  }

  async function upload(event) {
    event.preventDefault()
    const file = new FormData(event.currentTarget).get('file')
    if (!file?.name) return
    const body = new FormData()
    body.append('file', file)
    const result = await perform(`/api/bookings/${selected.id}/documents`, { method: 'POST', body }, 'PDF uploaded securely.')
    if (result) {
      setDocuments(await api(`/api/bookings/${selected.id}/documents`, { token }))
      event.currentTarget.reset()
    }
  }

  async function saveOffline(doc) {
    try {
      const response = await fetch(`${API}/api/documents/${doc.id}`, { headers: { Authorization: `****** } })
      if (!response.ok) throw new Error('Could not download the document.')
      const db = await openDocsDb()
      const tx = db.transaction('documents', 'readwrite')
      tx.objectStore('documents').put({ id: doc.id, filename: doc.filename, blob: await response.blob() })
      tx.oncomplete = () => say(`${doc.filename} saved on this device for offline access.`)
    } catch (issue) { problem(issue.message) }
  }

  async function showOfflineDocs() {
    try {
      const db = await openDocsDb()
      const rows = await new Promise((resolve) => {
        const request = db.transaction('documents').objectStore('documents').getAll()
        request.onsuccess = () => resolve(request.result)
      })
      if (!rows.length) { say('No offline PDFs saved yet. Open a booking and choose “Save offline”.'); return }
      rows.forEach((row) => {
        const link = document.createElement('a')
        link.href = URL.createObjectURL(row.blob)
        link.download = row.filename
        link.click()
        setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      })
      say(`${rows.length} saved PDF${rows.length > 1 ? 's' : ''} opened from this device.`)
    } catch (issue) { problem(issue.message) }
  }

  async function saveProfile(event) {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(event.currentTarget))
    const result = await perform('/api/auth/me', { method: 'PATCH', body: JSON.stringify(data) }, 'Profile updated.')
    if (result) setProfile({ ...profile, ...result })
  }

  async function install() {
    if (!installPrompt) { say('Open your browser menu and choose “Install app” or “Add to Home screen”.'); return }
    installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  function signOut() {
    localStorage.removeItem('trucklink-session')
    setSession(null); setSelected(null); setPage('home')
    say('Signed out. Offline documents remain saved on this device.')
  }

  const current = selected ? (bookings.find((b) => b.id === selected.id) || selected) : null
  const nav = session ? [
    ['dashboard', 'Home', '⌂'],
    [session.user.role === 'customer' ? 'create' : 'market', session.user.role === 'customer' ? 'Book a truck' : 'Find loads', '+'],
    ['history', 'Trips', '▤'], ['profile', 'Profile', '○'],
  ] : []

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => setPage(session ? 'dashboard' : 'home')}><span className="brand-mark">T</span><span>Truck<span>Link</span></span></button>
      <div className="top-actions"><span className={`network ${online ? 'is-online' : 'is-offline'}`}><i />{online ? 'Online' : 'Offline'}</span><button className="button button-outline button-small" onClick={install}>Install app</button>{session && <button className="avatar" onClick={() => setPage('profile')} aria-label="Profile">{session.user.name[0]}</button>}</div>
    </header>
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}

    {!session && page === 'home' && <Landing setPage={setPage} showOfflineDocs={showOfflineDocs} />}
    {!session && ['login', 'register'].includes(page) && <Auth page={page} setPage={setPage} onSubmit={authenticate} />}
    {session && <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-user"><span className="avatar avatar-large">{session.user.name[0]}</span><div><strong>{session.user.name}</strong><small>{session.user.role === 'customer' ? 'Goods owner' : 'Truck driver'}</small></div></div>
        <nav>{nav.map(([key, label, icon]) => <button key={key} className={page === key ? 'nav-item active' : 'nav-item'} onClick={() => { setPage(key); setSelected(null) }}><span>{icon}</span>{label}</button>)}</nav>
        <div className="sidebar-bottom"><button className="nav-item" onClick={() => setPage('help')}><span>?</span>Help & guidance</button><button className="nav-item" onClick={showOfflineDocs}><span>↓</span>Offline documents</button><button className="nav-item" onClick={signOut}><span>↪</span>Sign out</button><p>Demo payments only — no real money is moved.</p></div>
      </aside>
      <main className="content">
        {page === 'dashboard' && <Dashboard user={session.user} active={active} complete={complete} setPage={setPage} select={selectBooking} />}
        {page === 'create' && <CreateBooking onSubmit={createBooking} estimate={estimate} />}
        {page === 'market' && <Marketplace jobs={available} onAccept={accept} onSelect={selectBooking} />}
        {page === 'history' && <History bookings={bookings} onSelect={selectBooking} />}
        {page === 'booking' && current && <BookingDetail booking={current} role={session.user.role} location={location} documents={documents} issueCode={issueCode} verify={verify} perform={perform} shareLocation={shareLocation} onUpload={upload} saveOffline={saveOffline} />}
        {page === 'profile' && profile && <Profile profile={profile} onSave={saveProfile} />}
        {page === 'help' && <Help />}
      </main>
    </div>}
    {session && <nav className="mobile-nav" aria-label="Main navigation">{nav.map(([key, label, icon]) => <button key={key} className={page === key ? 'active' : ''} onClick={() => { setPage(key); setSelected(null) }}><span>{icon}</span>{label}</button>)}</nav>}
  </div>
}

function Landing({ setPage, showOfflineDocs }) {
  return <main className="landing">
    <section className="hero"><div><span className="eyebrow"><i /> FREIGHT, WITHOUT THE FRICTION</span><h1>Move goods.<br /><em>Move forward.</em></h1><p>One simple place to book a truck, find reliable loads and keep every trip on track.</p><div className="hero-buttons"><button className="button button-primary" onClick={() => setPage('register')}>Get started <span>→</span></button><button className="button button-quiet" onClick={() => setPage('login')}>I already have an account</button></div><div className="hero-proof">✓ &nbsp;Clear fares · Verified trip steps · Built for India</div></div>
      <div className="hero-art" aria-hidden="true"><div className="route-line"><i /><i /><i /></div><div className="route-card origin"><small>FROM</small><strong>Goods ready</strong><span>Pickup location</span></div><div className="truck-illustration"><div className="truck-box" /><div className="truck-cab" /><i /><i /></div><div className="route-card destination"><small>TO</small><strong>On its way</strong><span>Delivery destination</span></div><div className="art-note"><b>₹</b><span><strong>Fare upfront</strong><small>No surprises</small></span></div></div>
    </section>
    <section className="how"><div><span className="eyebrow">HOW TRUCKLINK WORKS</span><h2>Three steps. One smooth trip.</h2></div><div className="steps"><article><b>01</b><h3>Share your load</h3><p>Tell us where it starts, where it goes and what you’re moving.</p></article><article><b>02</b><h3>Match with a driver</h3><p>Drivers see the fare and trip details before accepting.</p></article><article><b>03</b><h3>Track and verify</h3><p>Follow the trip and confirm pickup and delivery with a demo OTP.</p></article></div></section>
    <footer><span>TruckLink © {new Date().getFullYear()}</span><button onClick={showOfflineDocs}>Saved offline PDFs</button><span>Academic demo · No real payment transfers</span></footer>
  </main>
}

function Auth({ page, setPage, onSubmit }) {
  return <main className="auth-page"><button className="back-link" onClick={() => setPage('home')}>← Back to TruckLink</button><section className="auth-card">
    <span className="eyebrow">{page === 'register' ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</span><h1>{page === 'register' ? 'Let’s get moving.' : 'Good to see you.'}</h1><p>{page === 'register' ? 'Choose how you’ll use TruckLink. Update your profile anytime.' : 'Sign in to pick up where you left off.'}</p>
    <form className="form-stack" onSubmit={onSubmit}>
      {page === 'register' && <><label>Full name<input name="name" autoComplete="name" minLength="2" required placeholder="Your name" /></label><label>Phone number<input name="phone" type="tel" autoComplete="tel" minLength="8" required placeholder="+91 98765 43210" /></label><label>I am a<select name="role"><option value="customer">Goods owner</option><option value="driver">Truck driver</option></select></label><label className="driver-field">Truck type<select name="vehicle_type"><option value="mini">Mini truck</option><option value="pickup">Pickup</option><option value="truck">Truck</option><option value="heavy">Heavy truck</option></select></label><label className="driver-field">Truck registration<input name="registration" placeholder="e.g. MH 12 AB 1234" /></label></>}
      <label>Email address<input name="email" type="email" autoComplete="email" required placeholder="you@example.com" /></label><label>Password<input name="password" type="password" autoComplete={page === 'register' ? 'new-password' : 'current-password'} minLength={page === 'register' ? 8 : undefined} required placeholder={page === 'register' ? 'At least 8 characters' : 'Your password'} /></label><button className="button button-primary button-wide">{page === 'register' ? 'Create account' : 'Sign in'} <span>→</span></button>
    </form><p className="switch-auth">{page === 'register' ? 'Already have an account?' : 'New to TruckLink?'} <button onClick={() => setPage(page === 'register' ? 'login' : 'register')}>{page === 'register' ? 'Sign in' : 'Create an account'}</button></p>
  </section></main>
}

function Dashboard({ user, active, complete, setPage, select }) {
  const total = complete.reduce((sum, item) => sum + item.fare, 0)
  return <div className="page-wrap"><div className="page-heading"><div><span className="eyebrow">YOUR TRUCKLINK</span><h1>{new Date().getHours() < 12 ? 'Good morning' : 'Good day'}, {user.name.split(' ')[0]}.</h1><p>{user.role === 'customer' ? 'Let’s get your next delivery moving.' : 'Your next load is just around the corner.'}</p></div><span className="heading-avatar">{user.name[0]}</span></div>
    <div className="stats"><article><span>Active trips</span><strong>{active.length}</strong><small>Bookings in progress</small></article><article><span>Completed</span><strong>{complete.length}</strong><small>Trips done so far</small></article><article><span>{user.role === 'customer' ? 'Trip spending' : 'Demo earnings'}</span><strong>₹{total.toLocaleString('en-IN')}</strong><small>Completed trips only</small></article></div>
    <div className="section-heading"><div><h2>{active.length ? 'Your active trips' : 'Ready when you are'}</h2><p>{active.length ? 'Choose a trip to see its details and next steps.' : 'Get started with your next freight trip.'}</p></div><button className="text-button" onClick={() => setPage(user.role === 'customer' ? 'create' : 'market')}>{user.role === 'customer' ? 'Book a truck' : 'Find loads'} →</button></div>
    {active.length ? <BookingList bookings={active.slice(0, 4)} onSelect={select} /> : <div className="empty-card"><div className="empty-symbol">{user.role === 'customer' ? '↗' : '⇄'}</div><h3>{user.role === 'customer' ? 'Move goods with confidence' : 'Find a load that fits your truck'}</h3><p>{user.role === 'customer' ? 'Set pickup, destination and cargo details. See an estimated fare before posting.' : 'Compare distance, cargo weight and estimated fare before accepting.'}</p><button className="button button-primary" onClick={() => setPage(user.role === 'customer' ? 'create' : 'market')}>{user.role === 'customer' ? 'Create a transport request' : 'Browse available loads'} <span>→</span></button></div>}
  </div>
}

function CreateBooking({ onSubmit, estimate }) {
  const [distance, setDistance] = useState('120')
  const [vehicle, setVehicle] = useState('truck')
  return <div className="page-wrap narrow"><div className="page-heading"><div><span className="eyebrow">NEW TRANSPORT REQUEST</span><h1>Where should we go?</h1><p>Add your load details to get an upfront estimate.</p></div></div>
    <form className="panel form-stack" onSubmit={onSubmit}><div className="form-title"><b>1</b><span><strong>Trip details</strong><small>Use a town, city, or full address</small></span></div>
      <label>Pickup location<input name="pickup" minLength="2" required placeholder="e.g. Pune, Maharashtra" /></label><label>Destination<input name="destination" minLength="2" required placeholder="e.g. Mumbai, Maharashtra" /></label>
      <div className="form-grid"><label>Estimated distance (km)<input name="distance_km" type="number" min="1" max="5000" value={distance} onChange={(e) => setDistance(e.target.value)} required /><small>Estimate only — confirm before booking.</small></label><label>Truck type<select name="vehicle_type" value={vehicle} onChange={(e) => setVehicle(e.target.value)}><option value="mini">Mini truck</option><option value="pickup">Pickup</option><option value="truck">Truck</option><option value="heavy">Heavy truck</option></select></label></div>
      <div className="form-title spaced"><b>2</b><span><strong>What are you moving?</strong><small>Help drivers check their truck capacity</small></span></div><div className="form-grid"><label>Goods type<input name="goods_type" required placeholder="e.g. Furniture, produce" /></label><label>Cargo weight (kg)<input name="weight_kg" type="number" min="1" max="100000" required placeholder="e.g. 1200" /></label></div>
      <label>Extra details <span className="optional">(optional)</span><textarea name="description" rows="3" maxLength="2000" placeholder="Loading notes or handling instructions" /></label>
      <div className="estimate"><div><span>Estimated fare</span><strong>₹{estimate(distance, vehicle).toLocaleString('en-IN')}</strong></div><small>₹{RATE}/km base × {vehicle} truck factor · minimum ₹500</small></div><p className="fine-print">Distance and fare are estimates. Final settlement is simulated in this prototype.</p><button className="button button-primary button-wide">Post transport request <span>→</span></button>
    </form></div>
}

function Marketplace({ jobs, onAccept, onSelect }) {
  return <div className="page-wrap"><div className="page-heading"><div><span className="eyebrow">AVAILABLE FREIGHT</span><h1>Find your next load.</h1><p>Review trip details and fare before you accept.</p></div><span className="count-pill">{jobs.length} available</span></div>
    {jobs.length ? <div className="job-grid">{jobs.map((job) => <article className="job-card" key={job.id}><div className="job-top"><span className="status-tag status-open">OPEN JOB</span><strong>₹{job.fare.toLocaleString('en-IN')}</strong></div><RouteText booking={job} /><div className="job-meta"><span>{job.distance_km} km</span><span>{job.goods_type}</span><span>{job.weight_kg.toLocaleString('en-IN')} kg</span></div>{job.description && <p>{job.description}</p>}<div className="job-actions"><button className="button button-primary" onClick={() => onAccept(job)}>Accept job</button><button className="button button-outline" onClick={() => onSelect(job)}>Details</button></div></article>)}</div> : <div className="empty-card"><h3>No open loads right now</h3><p>New customer requests show up here. Check back soon.</p></div>}
  </div>
}

function History({ bookings, onSelect }) {
  return <div className="page-wrap"><div className="page-heading"><div><span className="eyebrow">YOUR TRIPS</span><h1>Trip history</h1><p>Every request and its current status, in one place.</p></div></div>{bookings.length ? <BookingList bookings={bookings} onSelect={onSelect} /> : <div className="empty-card"><h3>No trips yet</h3><p>Your bookings will appear here when you post or accept a request.</p></div>}</div>
}

function BookingList({ bookings, onSelect }) {
  return <div className="booking-list">{bookings.map((b) => <button key={b.id} className="booking-row" onClick={() => onSelect(b)}><span className="booking-icon">{b.status === 'completed' ? '✓' : '↗'}</span><span className="booking-route"><strong>{b.pickup} <i>→</i> {b.destination}</strong><small>{b.goods_type} · {b.distance_km} km · {b.weight_kg.toLocaleString('en-IN')} kg</small></span><span className="booking-status"><strong>₹{b.fare.toLocaleString('en-IN')}</strong><small>{LABEL[b.status]}</small></span><span>›</span></button>)}</div>
}

function RouteText({ booking }) {
  return <div className="route-text"><div><i className="pickup-dot" /><span><small>PICKUP</small><strong>{booking.pickup}</strong></span></div><div><i className="destination-dot" /><span><small>DROP-OFF</small><strong>{booking.destination}</strong></span></div></div>
}

function BookingDetail({ booking, role, location, documents, issueCode, verify, perform, shareLocation, onUpload, saveOffline }) {
  const customer = role === 'customer'
  return <div className="page-wrap"><button className="back-link" onClick={() => history.back()}>← Back to trips</button><div className="page-heading"><div><span className="eyebrow">BOOKING TL-{String(booking.id).padStart(4, '0')}</span><h1>{booking.pickup} <i>→</i> {booking.destination}</h1><p>{booking.goods_type} · {booking.weight_kg.toLocaleString('en-IN')} kg · {booking.distance_km} km estimated</p></div><span className="status-tag">{LABEL[booking.status]}</span></div>
    <div className="detail-grid"><section className="panel"><div className="section-heading"><div><h2>Trip progress</h2><p>Both sides confirm important trip steps.</p></div></div>
      <ol className="progress">{[['accepted', 'Driver accepts'], ['loading_verified', 'Loading verified'], ['in_transit', 'Trip in progress'], ['completed', 'Delivery verified']].map(([key, label], index) => {
        const order = ['open', 'accepted', 'awaiting_loading', 'loading_verified', 'in_transit', 'delivered', 'completed']
        const reached = order.indexOf(booking.status) >= order.indexOf(key)
        return <li className={reached ? 'reached' : ''} key={key}><b>{reached ? '✓' : index + 1}</b><span><strong>{label}</strong><small>{['A driver has taken the job', 'Customer shares a demo code', 'Driver can share GPS location', 'Customer confirms delivery'][index]}</small></span></li>
      })}</ol>
      <div className="action-area">
        {customer && booking.status === 'accepted' && <button className="button button-primary" onClick={() => issueCode('start')}>Create loading verification code</button>}
        {customer && booking.status === 'in_transit' && <button className="button button-primary" onClick={() => issueCode('delivery')}>Create delivery verification code</button>}
        {!customer && ['awaiting_loading', 'delivered'].includes(booking.status) && <form className="otp-form" onSubmit={(e) => verify(e, booking, booking.status === 'delivered' ? 'delivery' : 'start')}><label>{booking.status === 'delivered' ? 'Delivery code from customer' : 'Loading code from customer'}<input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength="6" required placeholder="6-digit demo code" /></label><button className="button button-primary">Verify code</button></form>}
        {!customer && booking.status === 'loading_verified' && <button className="button button-primary" onClick={() => perform(`/api/bookings/${booking.id}/status?status=in_transit`, { method: 'PATCH' }, 'Trip started. Share GPS during the trip.')}>Start trip</button>}
        {!customer && booking.status === 'in_transit' && <button className="button button-outline" onClick={() => shareLocation(booking)}>Share my current location</button>}
        {customer && booking.status === 'open' && <button className="button button-danger" onClick={() => perform(`/api/bookings/${booking.id}/status?status=cancelled`, { method: 'PATCH' }, 'Booking cancelled.')}>Cancel request</button>}
        {customer && !['completed', 'cancelled'].includes(booking.status) && <p className="fine-print">Ask your driver to enter the code. Codes are demo-only; no SMS is sent.</p>}
        {booking.status === 'completed' && <div className="success">Trip complete. Thank you for using TruckLink!</div>}
      </div>
    </section>
    <section className="panel"><div className="section-heading"><div><h2>Fare & payment</h2><p>Estimated pricing — demo settlement only.</p></div></div><div className="fare-rows"><div><span>{booking.distance_km} km estimated</span><b>₹{booking.fare.toLocaleString('en-IN')}</b></div><div><span>Paid (simulated)</span><b>₹{booking.paid.toLocaleString('en-IN')}</b></div><div className="fare-total"><span>Balance</span><b>₹{booking.balance.toLocaleString('en-IN')}</b></div></div>
      {customer && booking.status === 'accepted' && booking.balance > 0 && <button className="button button-outline button-wide" onClick={() => perform(`/api/bookings/${booking.id}/payment?kind=deposit`, { method: 'POST' }, 'Demo payment recorded. No money was transferred.')}>Simulate 20% deposit</button>}
      {customer && booking.status === 'completed' && booking.balance > 0 && <button className="button button-primary button-wide" onClick={() => perform(`/api/bookings/${booking.id}/payment?kind=settlement`, { method: 'POST' }, 'Demo settlement recorded. No money was transferred.')}>Simulate final settlement</button>}
      <div className="demo-label">ACADEMIC DEMO · NO MONEY TRANSFERRED</div>
    </section>
    {!['open', 'cancelled'].includes(booking.status) && <section className="panel map-panel"><div className="section-heading"><div><h2>Live location</h2><p>{location ? 'Latest GPS update from the driver.' : 'Location appears after your driver shares it.'}</p></div><span className={`share-state ${location ? 'on' : ''}`}>{location ? 'Location received' : 'Not sharing'}</span></div><MapView point={location} /><p className="fine-print">GPS is shared only on an active trip. If it’s missing, check location permission and internet connection.</p></section>}
    {booking.status !== 'cancelled' && <section className="panel"><div className="section-heading"><div><h2>Trip documents</h2><p>Upload a PDF and save it on this device for offline access.</p></div></div><form className="upload-row" onSubmit={onUpload}><input name="file" type="file" accept="application/pdf,.pdf" required /><button className="button button-outline">Upload PDF</button></form>
      {documents.map((doc) => <div className="document-row" key={doc.id}><strong>▤ &nbsp;{doc.filename}</strong><button className="text-button" onClick={() => saveOffline(doc)}>Save offline ↓</button><a href={`${API}${doc.download_url}`} target="_blank" rel="noreferrer">Open</a></div>)}
    </section>}
    </div></div>
}

function Profile({ profile, onSave }) {
  return <div className="page-wrap narrow"><div className="page-heading"><div><span className="eyebrow">YOUR ACCOUNT</span><h1>Profile & settings</h1><p>Keep your contact details up to date.</p></div></div><form className="panel form-stack" onSubmit={onSave}><label>Full name<input name="name" defaultValue={profile.name} required minLength="2" /></label><label>Phone number<input name="phone" type="tel" defaultValue={profile.phone} required minLength="8" /></label><label>Email address<input value={profile.email} readOnly /></label><label>Account type<input value={profile.role === 'customer' ? 'Goods owner' : 'Truck driver'} readOnly /></label>{profile.truck && <><label>Truck registration<input value={profile.truck.registration} readOnly /></label><label>Vehicle capacity<input value={`${profile.truck.capacity_kg.toLocaleString('en-IN')} kg`} readOnly /></label></>}<button className="button button-primary">Save profile</button></form></div>
}

function Help() {
  return <div className="page-wrap narrow"><div className="page-heading"><div><span className="eyebrow">HERE TO HELP</span><h1>Simple trip guidance</h1><p>TruckLink is an academic prototype, built to make freight steps clear.</p></div></div><div className="help-list"><article><b>01</b><div><h3>Fares are estimates</h3><p>Fares use estimated distance × ₹20/km, a vehicle type multiplier and ₹500 minimum. This is not a binding quote.</p></div></article><article><b>02</b><div><h3>Demo verification codes</h3><p>Customers create a code on the trip screen and share it with their driver. No SMS messages are sent.</p></div></article><article><b>03</b><div><h3>Payments are simulated</h3><p>Payment buttons record a demo deposit or settlement. No bank, card or wallet is charged.</p></div></article><article><b>04</b><div><h3>Location sharing</h3><p>Drivers share their current GPS location manually during active trips. Location is never tracked outside a trip.</p></div></article><article><b>05</b><div><h3>Offline PDFs</h3><p>Save a booking document offline to access it from this device without a network connection.</p></div></article></div></div>
}

export default App
