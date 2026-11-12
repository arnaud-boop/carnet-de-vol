'use strict';
// SkyLog · Carnet de vol
// The page holds no flight data. Flights live in a private GitHub repository:
//   flights.json          the flights and the airports they use
//   photos/<name>.jpg     one image file per flight photo
// Each save is one commit, so GitHub keeps the full history.

// ═══════════════════════════════════════
//  STATE
// ═══════════════════════════════════════
const CFG_KEY = 'carnet_config';     // { owner, repo, branch, token } for this device
const CACHE_KEY = 'carnet_cache';    // last copy of the data, shown first and when offline
const GH_API = 'https://api.github.com';
const DATA_FILE = 'flights.json';

let cfg = null;
let flights = [];
let countryStatus = {};               // passport: country code -> 'visited' | 'stopover' | 'land'
let dataSha = null;                  // version of flights.json this device last saw
let saving = false;

const $ = id => document.getElementById(id);

// ═══════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function fmtInt(n) { return Math.round(n || 0).toLocaleString('en-US'); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
// Search key: upper case, no accents, so "Bodo" finds "Bodø" and "Gdansk" finds "Gdańsk"
const SPECIAL = { 'Ø': 'O', 'Æ': 'AE', 'Œ': 'OE', 'Ł': 'L', 'Đ': 'D', 'ẞ': 'SS', 'Þ': 'TH' };
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[ØÆŒŁĐẞÞ]/g, c => SPECIAL[c]);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function getDistance(from, to) {
  const a = AIRPORTS[from], b = AIRPORTS[to];
  return (a && b) ? Math.round(haversine(a.lat, a.lon, b.lat, b.lon)) : 0;
}

// CO2 estimate: emission factor per km, cabin multiplier, radiative forcing index
function calcCO2(distKm, cabinClass) {
  if (!distKm) return 0;
  const baseKgPerKm = distKm < 1500 ? 0.158 : 0.141;
  const mult = { economy: 1.0, premium: 1.5, business: 2.0, first: 4.0 };
  return Math.round(distKm * baseKgPerKm * (mult[cabinClass] || 1.0) * 2.0);
}
function co2Of(f) { return f.co2kg || calcCO2(f.distKm, f.cabinClass); }
function formatCO2(kg) {
  if (!kg) return '–';
  return kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${fmtInt(kg)} kg`;
}
function kmToMiles(km) { return km * 0.621371; }
function formatDist(km) { return km ? `${fmtInt(km)} km` : '–'; }

// Dates are stored as YYYY-MM-DD and shown as day/month/year
function formatDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '–';
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const CABIN_LABEL = { economy: 'Économique', premium: 'Premium Éco', business: 'Affaires', first: 'Première' };
function classBadge(c) {
  const map = { economy: 'badge-eco', premium: 'badge-prem', business: 'badge-biz', first: 'badge-first' };
  return `<span class="badge ${map[c] || 'badge-eco'}">${esc(CABIN_LABEL[c] || c)}</span>`;
}

let toastTimer = null;
function showToast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = err ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, err ? 6500 : 2800);
}

// Duration: stored in minutes, shown as "2h 05m"
function fmtDur(mins) {
  if (mins == null || mins === '' || !(mins > 0)) return '';
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
function fmtMins(mins) {
  if (!mins) return '–';
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
}
// Accepts "2h 05m", "2h05", "2h", "2:05", "125" (minutes). Returns minutes or null.
function parseDuration(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{1,2})\s*h\s*(\d{1,2})?\s*(?:m|min)?$/))) return +m[1] * 60 + +(m[2] || 0);
  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) return +m[1] * 60 + +m[2];
  if ((m = s.match(/^(\d{1,4})\s*(?:m|min)?$/))) return +m[1];
  return null;
}

// Convert a local time in an IANA time zone to a UTC Date. Correct across daylight saving changes.
function localToUTCDate(dateStr, timeStr, ianaZone) {
  const localAsUTC = new Date(`${dateStr}T${timeStr}:00Z`);
  const tzStr = localAsUTC.toLocaleString('en-US', {
    timeZone: ianaZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const m = tzStr.match(/(\d+)\/(\d+)\/(\d+),\s*(\d+):(\d+):(\d+)/);
  if (!m) return localAsUTC;
  let [, mo, da, yr, hr, mn, sc] = m.map(Number);
  if (hr === 24) hr = 0;
  const tzAsUTC = new Date(Date.UTC(yr, mo - 1, da, hr, mn, sc));
  return new Date(localAsUTC.getTime() + (localAsUTC.getTime() - tzAsUTC.getTime()));
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('script'));
    document.head.appendChild(s);
  });
}
async function needXLSX() {
  if (typeof XLSX !== 'undefined') return true;
  try { await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'); return typeof XLSX !== 'undefined'; }
  catch (e) { showToast('Le module Excel ne se charge pas. Vérifiez la connexion internet.', true); return false; }
}

// ═══════════════════════════════════════
//  DATA FORMAT
// ═══════════════════════════════════════
// Reads one flight in the current format or in the old export format
// (duration as text, photo as embedded image) and returns the current format.
function normalizeFlight(f) {
  if (!f || typeof f !== 'object') return null;
  const s = v => (v == null ? '' : String(v).trim());
  const code = v => { const c = s(v).toUpperCase(); return /^[A-Z0-9]{3}$/.test(c) ? c : ''; };
  const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(s(v)) ? s(v) : '');
  const time = v => (/^\d{2}:\d{2}$/.test(s(v)) ? s(v) : '');
  const num = v => (Number.isFinite(+v) && +v > 0 ? Math.round(+v) : null);
  const cabin = ['economy', 'premium', 'business', 'first'].includes(f.cabinClass) ? f.cabinClass : 'economy';
  let photo = null;
  if (typeof f.photo === 'string') {
    if (/^photos\/[A-Za-z0-9_.-]+$/.test(f.photo) || /^data:image\/jpeg;base64,/.test(f.photo)) photo = f.photo;
  }
  return {
    id: /^[A-Za-z0-9_-]{1,40}$/.test(s(f.id)) ? s(f.id) : uid(),
    from: code(f.from), to: code(f.to),
    date: date(f.date),
    departureTime: time(f.departureTime),
    arrivalDate: date(f.arrivalDate) || null,
    arrivalTime: time(f.arrivalTime),
    durationMin: Number.isFinite(f.durationMin) && f.durationMin > 0 ? Math.round(f.durationMin) : parseDuration(f.duration),
    airline: s(f.airline), flightNumber: s(f.flightNumber), cabinClass: cabin,
    registration: s(f.registration).toUpperCase(), aircraftType: s(f.aircraftType),
    seat: s(f.seat), coTravelers: s(f.coTravelers), notes: s(f.notes),
    distKm: num(f.distKm), co2kg: num(f.co2kg), photo
  };
}

function addAirports(map) {
  if (!map || typeof map !== 'object') return;
  for (const [code, a] of Object.entries(map)) {
    if (!/^[A-Z0-9]{3}$/.test(code) || !a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    AIRPORTS[code] = {
      name: String(a.name || code), city: String(a.city || a.name || code), country: String(a.country || ''),
      lat: a.lat, lon: a.lon, tz: a.tz || AIRPORTS[code]?.tz || null
    };
  }
}

function applyDoc(doc) {
  const list = Array.isArray(doc) ? doc : doc?.flights;
  if (!Array.isArray(list)) throw new StoreError('Le fichier de données a un format inattendu.', -1);
  addAirports(doc.airports);
  flights = list.map(normalizeFlight).filter(Boolean);
  countryStatus = {};
  const cs = !Array.isArray(doc) && doc.countryStatus;
  if (cs && typeof cs === 'object') {
    for (const [cc, st] of Object.entries(cs)) if (/^[A-Z]{2}$/.test(cc) && ['visited', 'stopover', 'land'].includes(st)) countryStatus[cc] = st;
  }
}

// The file content: flights sorted by date, plus every airport they use.
// Airports are saved with the flights so the map, the countries and the
// durations never depend on a download.
function buildDoc() {
  const sorted = [...flights].sort((a, b) => (a.date + a.departureTime).localeCompare(b.date + b.departureTime));
  const airports = {};
  [...new Set(sorted.flatMap(f => [f.from, f.to]).filter(Boolean))].sort().forEach(c => {
    const a = AIRPORTS[c];
    if (a) airports[c] = { name: a.name, city: a.city, country: a.country, lat: a.lat, lon: a.lon, tz: a.tz || null };
  });
  const doc = { schema: 1, airports, flights: sorted };
  const cs = Object.keys(countryStatus).sort();
  if (cs.length) doc.countryStatus = Object.fromEntries(cs.map(cc => [cc, countryStatus[cc]]));
  return doc;
}

// ═══════════════════════════════════════
//  GITHUB STORE
// ═══════════════════════════════════════
class StoreError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

function ghUrl(path) {
  return `${GH_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}
const refQuery = () => `?ref=${encodeURIComponent(cfg.branch)}`;

async function ghFetch(url, opts = {}, raw = false) {
  const headers = {
    'Authorization': `Bearer ${cfg.token}`,
    'Accept': raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (opts.body) headers['Content-Type'] = 'application/json';
  let r;
  try { r = await fetch(url, { cache: 'no-store', ...opts, headers }); }
  catch (e) { throw new StoreError('Pas de connexion à GitHub. Vérifiez la connexion internet.', 0); }
  if (r.ok) return r;
  const msg = {
    401: 'La clé d\'accès est refusée ou a expiré.',
    403: 'GitHub refuse l\'accès. La clé doit avoir le droit « Contents : Read and write » sur le dépôt de données.',
    404: 'Dépôt ou fichier introuvable, ou clé sans accès à ce dépôt.',
    409: 'Les données ont changé sur un autre appareil.',
    422: 'Les données ont changé sur un autre appareil.'
  }[r.status] || `GitHub a répondu avec une erreur (${r.status}).`;
  throw new StoreError(msg, r.status);
}

// GitHub rejects parallel writes to one branch, so every read of the data
// file and every write goes through this single queue.
let chain = Promise.resolve();
function queue(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

async function loadRemote() {
  let r;
  try { r = await ghFetch(ghUrl(DATA_FILE) + refQuery()); }
  catch (e) {
    if (e.status !== 404) throw e;
    // No data file yet: check that the repository itself answers, then start empty
    await ghFetch(`${GH_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`);
    flights = []; dataSha = null; writeCache();
    return;
  }
  const j = await r.json();
  const text = (j.content && j.encoding === 'base64')
    ? b64ToUtf8(j.content)
    : await (await ghFetch(ghUrl(DATA_FILE) + refQuery(), {}, true)).text();   // files over 1 MB
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { throw new StoreError('Le fichier de données est illisible.', -1); }
  applyDoc(doc);
  dataSha = j.sha;
  writeCache();
}

async function putFile(path, b64, message, sha) {
  const body = { message, content: b64, branch: cfg.branch };
  if (sha) body.sha = sha;
  const r = await ghFetch(ghUrl(path), { method: 'PUT', body: JSON.stringify(body) });
  return (await r.json()).content.sha;
}

function persist(message) {
  return queue(async () => {
    dataSha = await putFile(DATA_FILE, utf8ToB64(JSON.stringify(buildDoc(), null, 2) + '\n'), message, dataSha);
    writeCache();
  });
}

// Applies a change in memory, then saves it. If the save fails the change is undone.
async function commitChange(mutate, message) {
  const before = flights.slice(), beforeCountries = { ...countryStatus };
  mutate();
  setStatus('busy', 'Enregistrement…');
  try {
    await persist(message);
    setStatus('ok');
    return true;
  } catch (e) {
    flights = before; countryStatus = beforeCountries;
    if (e.status === 409 || e.status === 422) {
      await reloadData(true);
      showToast('Les données ont changé sur un autre appareil. Elles sont rechargées. Recommencez la modification.', true);
    } else {
      setStatus('error', e.message);
      showToast(`Non enregistré. ${e.message}`, true);
    }
    return false;
  }
}

// ─── Photos: one image file per photo ───
const photoCache = new Map();   // path -> URL the browser can show

async function photoURL(path) {
  if (path.startsWith('data:')) return path;
  if (photoCache.has(path)) return photoCache.get(path);
  const r = await ghFetch(ghUrl(path) + refQuery(), {}, true);
  const url = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: 'image/jpeg' }));
  photoCache.set(path, url);
  return url;
}
function uploadPhoto(path, dataUrl, message) {
  return queue(async () => {
    await putFile(path, dataUrl.split(',')[1], message);
    photoCache.set(path, dataUrl);
  });
}
// Best effort: a photo file left behind does no harm
function deletePhoto(path, message) {
  if (!path || !path.startsWith('photos/')) return Promise.resolve();
  return queue(async () => {
    const meta = await (await ghFetch(ghUrl(path) + refQuery())).json();
    await ghFetch(ghUrl(path), { method: 'DELETE', body: JSON.stringify({ message, sha: meta.sha, branch: cfg.branch }) });
    photoCache.delete(path);
  }).catch(() => {});
}

// ─── Local copy and device settings ───
function writeCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ doc: buildDoc(), sha: dataSha, at: Date.now() })); } catch (e) {}
}
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
}
function readCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    return (c && c.owner && c.repo && c.token) ? { branch: 'main', ...c } : null;
  } catch (e) { return null; }
}

function setStatus(kind, text) {
  const el = $('sync-status');
  el.className = kind;
  const label = text || { ok: 'Synchronisé', busy: 'En cours…', error: 'Erreur' }[kind] || '';
  el.querySelector('span').textContent = kind === 'error' ? 'Non synchronisé' : label;
  el.title = label;
}
function showBanner(text) { $('banner-text').textContent = text; $('banner').hidden = false; }

async function reloadData(silent) {
  setStatus('busy', 'Chargement…');
  try {
    await queue(loadRemote);
    $('banner').hidden = true;
    setStatus('ok');
    renderAll();
    if (silent !== true) showToast('Données à jour.');
    return true;
  } catch (e) {
    setStatus('error', e.message);
    const c = readCache();
    const when = c?.at ? new Date(c.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : null;
    let text = e.message;
    if (e.status === 401) text += ' Créez une nouvelle clé sur GitHub, puis utilisez le menu « Déconnecter cet appareil » pour la saisir.';
    if (when) text += ` Affichage de la copie du ${when}.`;
    showBanner(text);
    return false;
  }
}

// ─── First use on a device ───
function showSetup(message) {
  $('app').hidden = true; $('header-actions').hidden = true; $('banner').hidden = true; $('nav').hidden = true;
  $('setup').hidden = false;
  $('setup-error').textContent = message || '';
  if (!$('cfg-repo').value) {
    const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
    if (m) $('cfg-repo').value = `${m[1]}/carnet-de-vol-data`;
  }
}
function showApp() {
  $('setup').hidden = true; $('app').hidden = false; $('header-actions').hidden = false; $('nav').hidden = false;
}

async function connect(e) {
  e.preventDefault();
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec($('cfg-repo').value.trim());
  const token = $('cfg-token').value.trim();
  if (!m) { $('setup-error').textContent = 'Écrivez le dépôt sous la forme compte/nom-du-depot.'; return; }
  if (!token) return;
  const btn = $('cfg-submit');
  btn.disabled = true; btn.textContent = 'Connexion…';
  $('setup-error').textContent = '';
  cfg = { owner: m[1], repo: m[2], branch: 'main', token };
  try {
    await queue(loadRemote);
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    $('cfg-token').value = '';
    showApp(); setStatus('ok'); renderAll();
    showToast(`Appareil connecté. ${flights.length} vol${flights.length > 1 ? 's' : ''} chargé${flights.length > 1 ? 's' : ''}.`);
  } catch (err) {
    cfg = null;
    $('setup-error').textContent = err.message || 'Connexion impossible.';
  } finally {
    btn.disabled = false; btn.textContent = 'Connecter';
  }
}

function disconnect() {
  if (!confirm('Supprimer la clé d\'accès et la copie locale de cet appareil ?\n\nLes vols restent enregistrés sur GitHub.')) return;
  try { localStorage.removeItem(CFG_KEY); localStorage.removeItem(CACHE_KEY); } catch (e) {}
  cfg = null; flights = []; dataSha = null;
  photoCache.forEach(u => { if (u.startsWith('blob:')) URL.revokeObjectURL(u); });
  photoCache.clear();
  showSetup();
}

// ─── Menu ───
function toggleMenu(e) { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; }
function menuDo(fn) { $('menu').hidden = true; fn(); }
function pickImport() { $('import-file').click(); }

// ═══════════════════════════════════════
//  VIEWS
// ═══════════════════════════════════════
let charts = [];

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  renderAll();
}
function renderAll() {
  if ($('app').hidden) return;
  const active = document.querySelector('.view.active')?.id;
  if (active === 'view-passport') renderPassport();
  else if (active === 'view-map') renderMap();
  else if (active === 'view-flights') renderFlightsTable();
  else if (active === 'view-journal') renderJournal();
  else if (active === 'view-analytics') renderAnalytics();
}
const city = code => AIRPORTS[code]?.city || code || '';

// ═══════════════════════════════════════
//  PASSPORT
// ═══════════════════════════════════════
// Country status. Countries reached by plane get an automatic status:
// "visited" when at least one stay was there, "stopover" when every visit
// was a connection left the same day. countryStatus (saved in the data file)
// can override it, and adds countries visited without flying ("land").
const STATUS_LABEL = { visited: 'visité en avion', land: 'visité sans avion', stopover: 'escale seulement' };

function countryInfo() {
  const trips = buildTrips();
  const auto = {};   // cc -> { visited: bool, first, trips:Set }
  const touch = (cc, date, tripIdx, isStay) => {
    if (!cc) return;
    const c = auto[cc] = auto[cc] || { stay: false, first: date, trips: new Set() };
    if (date < c.first) c.first = date;
    if (isStay) { c.stay = true; c.trips.add(tripIdx); }
  };
  const home = homeAirport();
  if (home && AIRPORTS[home]) touch(AIRPORTS[home].country, flights.reduce((m, f) => f.date < m ? f.date : m, '9999'), -1, true);
  trips.forEach((t, ti) => t.flights.forEach((f, i) => {
    const next = t.flights[i + 1];
    const transit = next && next.from === f.to && next.date === arrivalDay(f);
    touch(AIRPORTS[f.to]?.country, arrivalDay(f), ti, !transit);
    if (i === 0 && f.from !== home) touch(AIRPORTS[f.from]?.country, f.date, ti, true);
  }));
  const visited = [], stopover = [];
  for (const [cc, c] of Object.entries(auto)) {
    const autoStatus = c.stay ? 'visited' : 'stopover';
    const status = countryStatus[cc] === 'stopover' || countryStatus[cc] === 'visited' ? countryStatus[cc] : autoStatus;
    const row = { cc, first: c.first, trips: c.trips.size, status, auto: autoStatus, overridden: status !== autoStatus };
    (status === 'stopover' ? stopover : visited).push(row);
  }
  for (const [cc, st] of Object.entries(countryStatus)) {
    if (st === 'land' && !auto[cc]) visited.push({ cc, first: '', trips: 0, status: 'land', auto: null, overridden: true });
  }
  visited.sort((a, b) => (a.first || '9999').localeCompare(b.first || '9999') || a.cc.localeCompare(b.cc));
  stopover.sort((a, b) => a.first.localeCompare(b.first));
  return { visited, stopover, trips };
}

function homeAirport() {
  const counts = {};
  flights.forEach(f => [f.from, f.to].forEach(c => { counts[c] = (counts[c] || 0) + 1; }));
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
}

const STAMP_COLORS = ['#B23A2E', '#1E7864', '#2E6DAE', '#7A4FB0', '#B5651D', '#A33A6B', '#3E7D2A', '#9A6A12', '#2B6E8F', '#8C2A37'];
function stampHTML(row, i) {
  const cls = row.status === 'land' ? 'land' : row.status === 'stopover' ? 'stop' : '';
  const color = row.status === 'stopover' ? '' : `color:${STAMP_COLORS[i % STAMP_COLORS.length]};`;
  const rot = ((row.cc.charCodeAt(0) * 7 + row.cc.charCodeAt(1) * 3) % 15) - 7;
  const sub = row.status === 'land' ? 'sans avion'
    : row.status === 'stopover' ? 'escale'
    : `${row.first.slice(0, 4)}${row.trips > 1 ? ' · ' + row.trips + '×' : ''}`;
  return `<button type="button" class="stamp ${cls}" style="${color}transform:rotate(${rot}deg)" data-country="${esc(row.cc)}" title="${esc(countryName(row.cc))} : ${esc(STATUS_LABEL[row.status])}. Cliquer pour changer.">
    <span class="flag">${countryFlag(row.cc)}</span><span class="cn">${esc(countryName(row.cc))}</span><span class="yr">${esc(sub)}</span></button>`;
}

// Small world map for the passport cover, drawn once from world.js (simplified for its size)
let miniWorld = null;   // [{ cc, d }] SVG paths, equirectangular, 2 units per degree
const MINI = { x0: -180, x1: 192, y0: 84, y1: -57, k: 2 };
function miniWorldPaths() {
  if (miniWorld || typeof WORLD === 'undefined') return miniWorld || [];
  const X = lon => ((lon - MINI.x0) * MINI.k).toFixed(1), Y = lat => ((MINI.y0 - lat) * MINI.k).toFixed(1);
  miniWorld = WORLD.countries.map(c => {
    let d = '';
    let biggest = null;   // largest ring of the country, kept even when simplification removes everything
    c.r.forEach(r => {
      let x = 0, y = 0, lx = null, ly = null, ring = '', n = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (let i = 0; i < r.length; i += 2) {
        x += r[i]; y += r[i + 1];
        const lon = x / 100, lat = y / 100;
        minX = Math.min(minX, lon); maxX = Math.max(maxX, lon); minY = Math.min(minY, lat); maxY = Math.max(maxY, lat);
        // keep a point only when it moved at least 0.7 degree: plenty for a 360 px wide map
        if (lx === null || Math.abs(lon - lx) + Math.abs(lat - ly) >= 0.7) { ring += (n ? 'L' : 'M') + X(lon) + ' ' + Y(lat); lx = lon; ly = lat; n++; }
      }
      if (n >= 3) d += ring + 'Z';
      const size = (maxX - minX) + (maxY - minY);
      if (!biggest || size > biggest.size) biggest = { size, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    });
    // A country too small to survive (Singapore, Malta…) becomes a small diamond so it can still be coloured
    if (!d && biggest) {
      const r = 0.9;
      d = `M${X(biggest.cx)} ${Y(biggest.cy + r)}L${X(biggest.cx + r)} ${Y(biggest.cy)}L${X(biggest.cx)} ${Y(biggest.cy - r)}L${X(biggest.cx - r)} ${Y(biggest.cy)}Z`;
    }
    return { cc: c.c || '', d };
  }).filter(p => p.d);
  return miniWorld;
}
function miniWorldSVG(info) {
  const st = {};
  info.visited.forEach(r => { st[r.cc] = 'v'; });
  info.stopover.forEach(r => { st[r.cc] = 's'; });
  const w = (MINI.x1 - MINI.x0) * MINI.k, h = (MINI.y0 - MINI.y1) * MINI.k;
  const dots = usedAirportsAll().map(c => `<circle cx="${((AIRPORTS[c].lon - MINI.x0) * MINI.k).toFixed(1)}" cy="${((MINI.y0 - AIRPORTS[c].lat) * MINI.k).toFixed(1)}" r="2.6"/>`).join('');
  return `<svg class="mini-world" viewBox="0 0 ${w} ${h}" role="img" aria-label="Carte des pays visités">
    ${miniWorldPaths().map(p => `<path class="${st[p.cc] === 'v' ? 'v' : st[p.cc] === 's' ? 's' : ''}" d="${p.d}"/>`).join('')}
    <g class="dots">${dots}</g></svg>`;
}
function usedAirportsAll() { return [...new Set(flights.flatMap(f => [f.from, f.to]))].filter(c => AIRPORTS[c]); }

// Departure board: each value written in split-flap tiles
function flapTiles(text) {
  return `<span class="tiles">${[...String(text).toUpperCase()].map(ch => ch === ' ' ? '<i class="gap"></i>' : `<i>${esc(ch)}</i>`).join('')}</span>`;
}
function shortType(t) { return String(t || '').replace(/^(Boeing|Airbus|Embraer|Bombardier|De Havilland|ATR)\s+/i, '').trim(); }

function renderPassport() {
  const el = $('passport');
  if (!flights.length) {
    el.innerHTML = '<div class="empty-state"><div class="emoji">🛂</div><p>Le passeport se remplit avec les vols.</p><button class="btn btn-primary" onclick="openModal()">+ Ajouter le premier vol</button></div>';
    return;
  }
  const info = countryInfo();
  const km = flights.reduce((s, f) => s + (f.distKm || 0), 0);
  const mins = flights.reduce((s, f) => s + (f.durationMin || 0), 0);
  const airports = usedAirportsAll().length;
  const first = flights.reduce((m, f) => f.date < m ? f.date : m, '9999');
  const last = flights.reduce((m, f) => f.date > m ? f.date : m, '0000');
  const hours = Math.floor(mins / 60);
  const nCountries = info.visited.length;
  const totalCO2 = flights.reduce((s, f) => s + co2Of(f), 0);
  const home = homeAirport();
  const longest = [...flights].filter(f => f.durationMin > 0).sort((a, b) => b.durationMin - a.durationMin)[0];
  const count = key => { const o = {}; flights.forEach(f => { if (f[key]) o[f[key]] = (o[f[key]] || 0) + 1; }); return Object.entries(o).sort((a, b) => b[1] - a[1]); };
  const types = count('aircraftType'), airlines = count('airline');
  const tiedAirline = airlines[1] && airlines[1][1] === airlines[0][1] ? airlines[1][0] : '';
  const seats = { window: 0, middle: 0, aisle: 0 };
  flights.forEach(f => { const p = seatPosition(f)?.pos; if (p) seats[p]++; });
  const seatTotal = seats.window + seats.middle + seats.aisle;
  const [favPos, favN] = Object.entries(seats).sort((a, b) => b[1] - a[1])[0];
  const POS = { window: 'Hublot', middle: 'Milieu', aisle: 'Couloir' };
  const pad = s => (s + '<'.repeat(44)).slice(0, 44);
  const flags = info.visited.map(r => countryFlag(r.cc)).join(' ');

  const row = (label, value, sub, onclick) => `<button type="button" class="board-row" onclick="${onclick}">
      <span class="board-label">${label}</span>${flapTiles(value)}<span class="board-sub">${sub}</span></button>`;

  el.innerHTML = `
    <div class="cover">
      <div class="cover-top">
        <div><div class="cover-kicker">Carnet de vol · ${esc(home || '')}</div><h1>Passeport<br>de voyage</h1></div>
        <div class="emblem" aria-hidden="true">✈</div>
      </div>
      <div class="cover-map">${miniWorldSVG(info)}</div>
      <div class="cover-flags" title="Pays visités">${flags}</div>
      <div class="kpis">
        <button class="kpi" onclick="showView('flights')"><b>${flights.length}</b><span>vols</span></button>
        <button class="kpi" onclick="showDistancePopup()"><b>${fmtInt(km)}</b><span>km · ${(km / 40075).toFixed(1)}× la Terre</span></button>
        <button class="kpi" onclick="showDurationPopup()"><b>${hours} h</b><span>dans les airs</span></button>
        <button class="kpi" onclick="document.getElementById('stamps').scrollIntoView({behavior:'smooth',block:'start'})"><b>${nCountries}</b><span>pays visités</span></button>
        <button class="kpi" onclick="showAirportsPopup()"><b>${airports}</b><span>aéroports</span></button>
        <button class="kpi" onclick="showView('journal')"><b>${info.trips.length}</b><span>voyages</span></button>
      </div>
      <div class="cover-fields">
        <div><span>Premier vol</span><b>${formatDate(first)}</b></div>
        <div><span>Dernier vol</span><b>${formatDate(last)}</b></div>
        <div><span>Aéroport d'attache</span><b>${esc(home || '–')} · ${esc(city(home))}</b></div>
      </div>
      <div class="mrz" aria-hidden="true">${esc(pad('P<NOR<<CARNET<DE<VOL'))}<br>${esc(pad(`${flights.length}FLT<${Math.round(km)}KM<${nCountries}PAYS<${first.slice(0, 4)}`))}</div>
    </div>

    <h2 class="sec-title" id="stamps">Tampons</h2>
    <div class="legend">
      <span><i class="dot"></i>visité en avion</span>
      <span><i class="dot d"></i>visité sans avion</span>
      <span><i class="dot g"></i>escale seulement</span>
      <span class="muted">Un clic sur un tampon change son statut.</span>
    </div>
    <div class="stamps" id="stamps-visited">
      ${info.visited.map(stampHTML).join('')}
      <button type="button" class="stamp add" onclick="openAddCountry()" title="Ajouter un pays visité sans avion"><span class="flag">+</span><span class="cn">Ajouter un pays</span><span class="yr">sans avion</span></button>
    </div>
    ${info.stopover.length ? `<h2 class="sec-title" style="font-size:19px;margin-top:26px">Seulement en escale</h2>
    <div class="stamps" id="stamps-stopover">${info.stopover.map(stampHTML).join('')}</div>` : ''}

    <h2 class="sec-title">Tableau des records</h2>
    <div class="board">
      <div class="board-head"><span>Records</span><span>Valeur</span><span>Détail</span></div>
      ${row('Heures en vol', hours, `soit ${(mins / 60 / 24).toFixed(1)} jours`, 'showDurationPopup()')}
      ${longest ? row('Vol le plus long', `${longest.from}-${longest.to}`, `${fmtDur(longest.durationMin)} · ${fmtInt(longest.distKm)} km · ${formatDate(longest.date)}`, `openFlightDetail('${longest.id}')`) : ''}
      ${row('Tours de la Terre', (km / 40075).toFixed(1) + 'X', `${fmtInt(km)} km parcourus`, 'showDistancePopup()')}
      ${types.length ? row('Avion favori', shortType(types[0][0]).slice(0, 10), `${esc(types[0][0])} · ${plural(types[0][1], 'vol', 'vols')}`, "showView('analytics')") : ''}
      ${airlines.length ? row('Compagnie favorite', airlines[0][0].slice(0, 10), `${plural(airlines[0][1], 'vol', 'vols')}${tiedAirline ? ` · à égalité avec ${esc(tiedAirline)}` : ''}`, "showView('analytics')") : ''}
      ${seatTotal ? row('Place préférée', POS[favPos], `${favN} fois sur ${seatTotal} sièges connus`, "showView('analytics')") : ''}
      ${row('CO₂e estimé', (totalCO2 / 1000).toFixed(1) + 'T', 'forçage radiatif inclus', 'showCO2Popup()')}
    </div>`;
  addShowMore('stamps-visited', 8);
  addShowMore('stamps-stopover', 8);
}

// ─── Country sheet: change the status of one country ───
function openCountrySheet(cc) {
  const info = countryInfo();
  const row = [...info.visited, ...info.stopover].find(r => r.cc === cc);
  if (!row) return;
  const list = flights.filter(f => AIRPORTS[f.from]?.country === cc || AIRPORTS[f.to]?.country === cc).sort(byDateDesc);
  const opt = (status, label, help) => `<button type="button" class="${row.status === status ? 'on' : ''}" data-set-status="${status}">
      <span>${status === 'stopover' ? '◌' : status === 'land' ? '◍' : '●'}</span><span>${label}<small>${help}</small></span></button>`;
  const body = row.status === 'land'
    ? `<p class="muted" style="margin-bottom:12px">Pays ajouté à la main, visité sans avion.</p>
       <div class="choice"><button type="button" data-set-status="remove"><span>✕</span><span>Retirer ce pays<small>Il disparaît du passeport.</small></span></button></div>`
    : `<div class="choice">
        ${opt('visited', 'Visité', 'Compte dans les pays visités.')}
        ${opt('stopover', 'Escale seulement', 'Correspondance sans y séjourner. Ne compte pas.')}
       </div>
       ${row.overridden ? `<p class="muted" style="margin:-4px 0 12px">Choix fait à la main. Le calcul automatique donnait « ${esc(STATUS_LABEL[row.auto])} ». <button type="button" class="mp-link" data-set-status="auto">Revenir au calcul automatique</button></p>` : `<p class="muted" style="margin:-4px 0 12px">Statut calculé automatiquement à partir des vols.</p>`}
       ${list.length ? `<div class="section-label">${plural(list.length, 'vol', 'vols')}</div>
       <ul class="stat-popup-list">${list.map((f, i) => flightLi(f, i, esc(f.airline || ''))).join('')}</ul>` : ''}`;
  showStatPopup(`${countryFlag(cc)} ${countryName(cc)}`, body);
  $('stat-popup-body').dataset.country = cc;
}

async function setCountryStatus(cc, status) {
  const name = countryName(cc);
  const label = { visited: 'visité', stopover: 'escale seulement', land: 'visité sans avion', auto: 'calcul automatique', remove: 'retiré' }[status];
  closeModal('stat-popup-modal');
  const ok = await commitChange(() => {
    if (status === 'auto' || status === 'remove') delete countryStatus[cc];
    else countryStatus[cc] = status;
  }, `Passeport : ${name}, ${label}`);
  if (ok) { showToast(`${name} : ${label}.`); renderAll(); }
}

// Every country with an ISO code from the map outlines, in French, sorted
function allCountries() {
  const codes = typeof WORLD !== 'undefined' ? [...new Set(WORLD.countries.map(c => c.c).filter(Boolean))] : [];
  return codes.map(cc => [cc, countryName(cc)]).sort((a, b) => a[1].localeCompare(b[1], 'fr'));
}

function openAddCountry() {
  const known = new Set([...countryInfo().visited, ...countryInfo().stopover].map(r => r.cc));
  const options = allCountries().filter(([cc]) => !known.has(cc))
    .map(([cc, name]) => `<option value="${esc(cc)}">${countryFlag(cc)} ${esc(name)}</option>`).join('');
  showStatPopup('Ajouter un pays visité sans avion', `
    <p class="muted" style="margin-bottom:8px">Par exemple un pays visité en train, en voiture ou en bateau.</p>
    <select class="country-select" id="add-country-select"><option value="">Choisir un pays…</option>${options}</select>
    <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('stat-popup-modal')">Annuler</button>
    <button type="button" class="btn btn-primary" onclick="const v=$('add-country-select').value; if(v) setCountryStatus(v,'land')">Ajouter</button></div>`);
}

// ─── Theme (per device) ───
const THEMES = ['light', 'dark', 'auto'];
const THEME_LABEL = { light: 'clair', dark: 'sombre', auto: 'automatique' };
function currentTheme() { return document.documentElement.dataset.theme || 'light'; }
function updateThemeButton() { if ($('theme-btn')) $('theme-btn').textContent = `Thème : ${THEME_LABEL[currentTheme()]}`; }
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('carnet_theme', next); } catch (e) {}
  updateThemeButton();
  renderAll();
  showToast(`Thème ${THEME_LABEL[next]}.`);
}

// ═══════════════════════════════════════
//  STAT POPUPS
// ═══════════════════════════════════════
function countryFlag(code) {
  if (!/^[A-Za-z]{2}$/.test(code || '')) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
}
function countryName(cc) {
  try { return new Intl.DisplayNames(['fr'], { type: 'region' }).of(cc) || cc; } catch (e) { return cc; }
}
function showStatPopup(title, html) {
  delete $('stat-popup-body').dataset.country;
  $('stat-popup-title').textContent = title;
  $('stat-popup-body').innerHTML = html;
  $('stat-popup-modal').classList.add('open');
}
function flightLi(f, i, value, valueStyle = '') {
  return `<li>
    <span class="stat-popup-rank">${i + 1}</span>
    <span class="stat-popup-label" style="color:var(--accent2)">${esc(f.from || '?')} → ${esc(f.to || '?')}</span>
    <span class="stat-popup-sub">${esc(city(f.from))} → ${esc(city(f.to))}, ${formatDate(f.date)}</span>
    <span class="stat-popup-value" style="${valueStyle}">${value}</span>
  </li>`;
}

function showAirportsPopup() {
  if (!flights.length) return;
  const dep = {}, arr = {};
  flights.forEach(f => {
    if (f.from) dep[f.from] = (dep[f.from] || 0) + 1;
    if (f.to) arr[f.to] = (arr[f.to] || 0) + 1;
  });
  const rows = [...new Set([...Object.keys(dep), ...Object.keys(arr)])]
    .map(c => ({ c, dep: dep[c] || 0, arr: arr[c] || 0 }))
    .sort((a, b) => (b.dep + b.arr) - (a.dep + a.arr))
    .map((x, i) => {
      const ap = AIRPORTS[x.c];
      return `<li>
        <span class="stat-popup-rank">${i + 1}</span>
        <span class="stat-popup-label" style="color:var(--accent2);font-weight:700">${esc(x.c)}</span>
        <span class="stat-popup-sub">${ap ? esc(`${ap.city}, ${countryName(ap.country)}`) : ''}</span>
        <span class="stat-popup-value" title="départs et arrivées">↑${x.dep} ↓${x.arr}</span>
      </li>`;
    }).join('');
  showStatPopup('🏢 Aéroports', `<ul class="stat-popup-list">${rows}</ul>`);
}

function showCO2Popup() {
  if (!flights.length) return;
  const rows = [...flights].sort((a, b) => co2Of(b) - co2Of(a))
    .map((f, i) => flightLi(f, i, formatCO2(co2Of(f)), 'color:var(--green)')).join('');
  showStatPopup('🌱 Vols par CO₂e (du plus élevé au plus faible)', `<ul class="stat-popup-list">${rows}</ul>`);
}

function showDurationPopup() {
  if (!flights.length) return;
  const list = flights.filter(f => f.durationMin > 0).sort((a, b) => b.durationMin - a.durationMin);
  if (!list.length) {
    showStatPopup('⏱️ Temps en vol', '<p style="color:var(--text3);padding:8px 0">Aucune durée enregistrée. Ajoutez les heures de départ et d\'arrivée d\'un vol.</p>');
    return;
  }
  showStatPopup('⏱️ Vols par durée (du plus long au plus court)',
    `<ul class="stat-popup-list">${list.map((f, i) => flightLi(f, i, fmtDur(f.durationMin))).join('')}</ul>`);
}

function showDistancePopup() {
  if (!flights.length) return;
  const rows = flights.filter(f => f.distKm > 0).sort((a, b) => b.distKm - a.distKm)
    .map((f, i) => flightLi(f, i, `${fmtInt(f.distKm)} km`)).join('');
  showStatPopup('🌍 Vols par distance (du plus long au plus court)', `<ul class="stat-popup-list">${rows}</ul>`);
}

// ═══════════════════════════════════════
//  FLIGHTS TABLE
// ═══════════════════════════════════════
// "Mes vols": every flight as a compact ticket, grouped by year when sorted by date.
const SORTS = {
  'date-desc': { label: 'Plus récents d\'abord', val: f => f.date + f.departureTime, dir: -1, byYear: true },
  'date-asc': { label: 'Plus anciens d\'abord', val: f => f.date + f.departureTime, dir: 1, byYear: true },
  'dist-desc': { label: 'Plus longue distance', val: f => f.distKm || 0, dir: -1 },
  'dur-desc': { label: 'Plus longue durée', val: f => f.durationMin || 0, dir: -1 },
  'airline-asc': { label: 'Compagnie (A → Z)', val: f => norm(f.airline) + f.date, dir: 1 },
  'co2-desc': { label: 'Plus de CO₂e', val: f => co2Of(f), dir: -1 }
};
let sortMode = 'date-desc';
const MONTH_FR = new Intl.DateTimeFormat('fr-FR', { month: 'short' });
function monthShort(iso) { return MONTH_FR.format(new Date(iso + 'T12:00:00Z')).replace('.', ''); }

function flightTicket(f, showYear) {
  const meta = [f.aircraftType, f.registration].filter(Boolean).join(' · ');
  return `<li class="fl" data-flight="${esc(f.id)}" tabindex="0" role="button" aria-label="Voir le vol ${esc(f.from)} vers ${esc(f.to)} du ${formatDate(f.date)}">
    <div class="fl-date"><b>${esc(f.date.slice(8, 10))}</b><span>${esc(monthShort(f.date))}${showYear ? ' ' + esc(f.date.slice(0, 4)) : ''}</span></div>
    <div class="fl-route">
      <div class="fl-codes">${esc(f.from)}<i aria-hidden="true">✈</i>${esc(f.to)}</div>
      <div class="fl-sub">${esc(city(f.from))} → ${esc(city(f.to))}</div>
    </div>
    <div class="fl-air">
      <div>${esc(f.airline || '–')}${f.flightNumber ? ` <span class="fl-mono">${esc(f.flightNumber)}</span>` : ''}</div>
      <div class="fl-sub">${esc(meta || ' ')}</div>
    </div>
    <div class="fl-num">
      <div>${formatDist(f.distKm)}</div>
      <div class="fl-sub">${f.durationMin ? fmtDur(f.durationMin) : '–'}</div>
    </div>
    <div class="fl-tags">${f.cabinClass !== 'economy' ? classBadge(f.cabinClass) : ''}<span class="fl-ph">${f.photo ? '<span class="has-photo" title="Photo dans la fiche du vol" aria-label="avec photo">📷</span>' : ''}</span><span class="fl-seat-slot">${f.seat ? `<span class="fl-seat" title="Siège">${esc(f.seat)}</span>` : ''}</span></div>
  </li>`;
}

function renderFlightsTable() {
  updateYearFilter();
  // The class filter appears only when the logbook has more than one class
  const multiClass = new Set(flights.map(f => f.cabinClass)).size > 1;
  $('filter-class').hidden = !multiClass;
  if (!multiClass) $('filter-class').value = '';
  if (!SORTS[$('sort-select').value]) $('sort-select').value = sortMode;
  sortMode = $('sort-select').value;
  const search = norm($('search-input').value);
  const year = $('filter-year').value, cls = $('filter-class').value;

  const filtered = flights.filter(f => {
    const a = AIRPORTS[f.from] || {}, b = AIRPORTS[f.to] || {};
    const str = norm([f.from, f.to, f.airline, f.flightNumber, f.registration, f.aircraftType, a.city, b.city, a.name, b.name, f.coTravelers].join(' '));
    if (search && !str.includes(search)) return false;
    if (year && !f.date.startsWith(year)) return false;
    if (cls && f.cabinClass !== cls) return false;
    return true;
  });
  const sort = SORTS[sortMode];
  filtered.sort((a, b) => { const va = sort.val(a), vb = sort.val(b); return va < vb ? -sort.dir : va > vb ? sort.dir : 0; });

  const km = filtered.reduce((s, f) => s + (f.distKm || 0), 0);
  $('flights-count').textContent = flights.length
    ? `${plural(filtered.length, 'vol', 'vols')}${filtered.length !== flights.length ? ` sur ${flights.length}` : ''} · ${fmtInt(km)} km`
    : '';

  const box = $('flights-table');
  if (!flights.length) {
    box.innerHTML = '<div class="empty-state"><div class="emoji">✈️</div><p>Aucun vol pour l\'instant.</p><button class="btn btn-primary" onclick="openModal()">+ Ajouter le premier vol</button></div>';
    return;
  }
  if (!filtered.length) {
    box.innerHTML = '<div class="empty-state"><div class="emoji">🔍</div><p>Aucun vol ne correspond à ces filtres.</p></div>';
    return;
  }
  if (sort.byYear) {
    const groups = [];
    filtered.forEach(f => {
      const y = f.date.slice(0, 4);
      if (!groups.length || groups[groups.length - 1].year !== y) groups.push({ year: y, list: [] });
      groups[groups.length - 1].list.push(f);
    });
    box.innerHTML = groups.map(g => `<section class="fl-year">
        <div class="fl-year-head"><h2>${esc(g.year)}</h2><span>${plural(g.list.length, 'vol', 'vols')} · ${fmtInt(g.list.reduce((s, f) => s + (f.distKm || 0), 0))} km</span></div>
        <ol class="fl-list">${g.list.map(f => flightTicket(f, false)).join('')}</ol>
      </section>`).join('');
  } else {
    box.innerHTML = `<ol class="fl-list">${filtered.map(f => flightTicket(f, true)).join('')}</ol>`;
  }
}

function updateYearFilter() {
  const sel = $('filter-year');
  const years = [...new Set(flights.map(f => f.date.slice(0, 4)).filter(Boolean))].sort().reverse();
  const cur = sel.value;
  sel.innerHTML = '<option value="">Toutes années</option>' + years.map(y => `<option value="${esc(y)}" ${cur === y ? 'selected' : ''}>${esc(y)}</option>`).join('');
}

// ═══════════════════════════════════════
//  FLIGHT DETAIL
// ═══════════════════════════════════════
let detailId = null;

async function openFlightDetail(flightId) {
  const f = flights.find(x => x.id === flightId);
  if (!f) return;
  detailId = f.id;
  const fromA = AIRPORTS[f.from] || {}, toA = AIRPORTS[f.to] || {};
  const co2 = co2Of(f);
  const place = a => a.name ? `${esc(a.name)}<br>${esc(a.city)}, ${esc(countryName(a.country))}` : '';
  const arrDay = f.arrivalDate && f.arrivalDate !== f.date ? ` <span style="font-size:11px;color:var(--text3)">(${formatDate(f.arrivalDate)})</span>` : '';

  $('detail-modal-body').innerHTML = `
    <button class="modal-close" onclick="closeModal('detail-modal')" aria-label="Fermer">✕</button>
    <div class="detail-route">${esc(f.from || '?')} <span style="color:var(--text3)">→</span> ${esc(f.to || '?')}</div>
    <div class="detail-sub">${esc([f.airline, f.flightNumber].filter(Boolean).join(' · '))}${f.airline || f.flightNumber ? ' · ' : ''}${formatDate(f.date)}</div>

    <div class="detail-photo" id="detail-photo">
      ${f.registration
        ? '<div class="detail-photo-msg" style="padding-top:12px">🔍 Recherche d\'une photo de l\'avion…</div>'
        : '<div class="detail-photo-placeholder">✈️</div><div class="detail-photo-msg">Pas d\'immatriculation enregistrée</div>'}
    </div>

    ${co2 ? `<div class="detail-co2">
      <div class="detail-co2-icon">🌱</div>
      <div>
        <div class="detail-co2-val">${formatCO2(co2)} CO₂e</div>
        <div class="detail-co2-label">Empreinte carbone estimée, forçage radiatif inclus</div>
      </div>
    </div>` : ''}

    <div class="detail-grid">
      <div class="detail-item">
        <div class="detail-item-label">✈ Départ</div>
        <div class="detail-item-value">${esc(f.from || '–')} ${f.departureTime ? '· ' + esc(f.departureTime) : ''}</div>
        <div class="detail-item-sub">${place(fromA)}</div>
      </div>
      <div class="detail-item">
        <div class="detail-item-label">🛬 Arrivée</div>
        <div class="detail-item-value">${esc(f.to || '–')} ${f.arrivalTime ? '· ' + esc(f.arrivalTime) : ''}${arrDay}</div>
        <div class="detail-item-sub">${place(toA)}</div>
      </div>
      <div class="detail-item">
        <div class="detail-item-label">⏱ Durée</div>
        <div class="detail-item-value">${fmtDur(f.durationMin) || '–'}</div>
        <div class="detail-item-sub">${f.distKm ? formatDist(f.distKm) : ''}</div>
      </div>
      <div class="detail-item">
        <div class="detail-item-label">🎫 Classe</div>
        <div class="detail-item-value">${esc(CABIN_LABEL[f.cabinClass] || '–')}</div>
        <div class="detail-item-sub">${f.seat ? 'Siège ' + esc(f.seat) : 'Siège non enregistré'}</div>
      </div>
      ${f.aircraftType || f.registration ? `<div class="detail-item">
        <div class="detail-item-label">🛩 Avion</div>
        <div class="detail-item-value">${esc(f.aircraftType || '–')}</div>
        <div class="detail-item-sub">${esc(f.registration)}</div>
      </div>` : ''}
      <div class="detail-item">
        <div class="detail-item-label">🏢 Compagnie</div>
        <div class="detail-item-value">${esc(f.airline || '–')}</div>
        <div class="detail-item-sub">${esc(f.flightNumber)}</div>
      </div>
      ${f.coTravelers ? `<div class="detail-item" style="grid-column:1/-1">
        <div class="detail-item-label">👥 Voyagé avec</div>
        <div class="detail-item-value" style="font-size:14px">${esc(f.coTravelers)}</div>
      </div>` : ''}
    </div>

    ${f.notes ? `<div class="detail-notes">📝 ${esc(f.notes)}</div>` : ''}

    ${f.photo ? `<div style="margin-top:20px">
      <div class="section-label">📷 Photo du vol</div>
      <div id="user-photo" class="detail-photo-msg" style="text-align:left;padding:0">Chargement de la photo…</div>
    </div>` : ''}

    <div class="detail-actions">
      <button class="btn btn-ghost" onclick="closeModal('detail-modal')">Fermer</button>
      <button class="btn btn-secondary" onclick="closeModal('detail-modal');openModal('${f.id}')">Modifier</button>
      <button class="btn btn-primary" onclick="closeModal('detail-modal');openReturnFlight('${f.id}')" title="Nouveau vol ${esc(f.to)} → ${esc(f.from)}, prérempli">↩ Vol retour</button>
      <button class="btn btn-danger" style="margin-left:auto" onclick="deleteFlight('${f.id}')">Supprimer</button>
    </div>`;
  $('detail-modal').classList.add('open');
  const stillOpen = () => detailId === f.id && $('detail-modal').classList.contains('open');

  if (f.photo) {
    photoURL(f.photo).then(url => {
      if (!stillOpen() || !$('user-photo')) return;
      const img = new Image();
      img.className = 'user-photo'; img.alt = 'Photo du vol'; img.src = url;
      $('user-photo').replaceChildren(img);
    }).catch(e => { if (stillOpen() && $('user-photo')) $('user-photo').textContent = `Photo indisponible. ${e.message || ''}`; });
  }

  if (f.registration) {
    const box = () => (stillOpen() ? $('detail-photo') : null);
    const none = msg => { const el = box(); if (el) el.innerHTML = `<div class="detail-photo-placeholder">✈️</div><div class="detail-photo-msg">${esc(msg)}</div>`; };
    try {
      const resp = await fetch(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(f.registration)}`);
      const p = (await resp.json()).photos?.[0];
      const src = p?.thumbnail_large?.src || p?.thumbnail?.src;
      const el = box();
      if (!el) return;
      if (!src || !/^https:\/\//.test(src)) { none(`Pas de photo trouvée pour ${f.registration}`); return; }
      const link = /^https:\/\//.test(p.link || '') ? p.link : 'https://www.planespotters.net';
      el.innerHTML = `<img alt="${esc(f.registration)}" src="${esc(src)}">
        <div class="detail-photo-credit">📸 ${esc(p.photographer || 'Photographe inconnu')} · <a href="${esc(link)}" target="_blank" rel="noopener">Planespotters.net</a></div>`;
      el.querySelector('img').onerror = () => none('Photo indisponible');
    } catch (e) { none('Service de photos indisponible'); }
  }
}

// ═══════════════════════════════════════
//  MAP
// ═══════════════════════════════════════
function greatCirclePoints(lat1, lon1, lat2, lon2, n = 80) {
  const p1lat = lat1 * D2R, p1lon = lon1 * D2R, p2lat = lat2 * D2R, p2lon = lon2 * D2R;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2lat - p1lat) / 2) ** 2 + Math.cos(p1lat) * Math.cos(p2lat) * Math.sin((p2lon - p1lon) / 2) ** 2));
  if (d < 0.001) return [[lat1, lon1], [lat2, lon2]];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1lat) * Math.cos(p1lon) + B * Math.cos(p2lat) * Math.cos(p2lon);
    const y = A * Math.cos(p1lat) * Math.sin(p1lon) + B * Math.cos(p2lat) * Math.sin(p2lon);
    const z = A * Math.sin(p1lat) + B * Math.sin(p2lat);
    pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D, Math.atan2(y, x) * R2D]);
  }
  for (let i = 1; i < pts.length; i++) {   // keep the line continuous across the 180° meridian
    while (pts[i][1] - pts[i - 1][1] > 180) pts[i][1] -= 360;
    while (pts[i][1] - pts[i - 1][1] < -180) pts[i][1] += 360;
  }
  return pts;
}

// The map is drawn by MapLibre (WebGL) from the country outlines shipped with
// the site (world.js): no map provider, no key, smooth zoom, and a globe view.
let mapgl = null, mapReady = false, mapReadyQueue = [];
let routeKeys = new Set(), airportCodes = new Set();
let fittedFor = '';            // airports the map was last framed on
let mapSelection = null;       // { type: 'airport', code } or { type: 'route', key }
let hoverPopup = null;

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const routeKey = (a, b) => [a, b].sort().join('-');
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

function decodeRings(rings) {
  return rings.map(r => {
    const pts = [];
    let x = 0, y = 0;
    for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; pts.push([x / 100, y / 100]); }
    return pts;
  });
}
// Each ring becomes its own polygon: holes are rare and too small to matter here
let worldFeatures = null;
function worldGeoJSON(status) {
  if (!worldFeatures && typeof WORLD !== 'undefined') {
    worldFeatures = WORLD.countries.map(c => ({
      type: 'Feature', properties: { cc: c.c || '' },
      geometry: { type: 'MultiPolygon', coordinates: decodeRings(c.r).map(ring => [ring]) }
    }));
  }
  return {
    type: 'FeatureCollection',
    features: (worldFeatures || []).map(f => ({ ...f, properties: { cc: f.properties.cc, status: status[f.properties.cc] || 'other' } }))
  };
}

function mapPaint() {
  return {
    ocean: cssVar('--ocean'), land: cssVar('--land'), landLine: cssVar('--land-line'),
    visited: cssVar('--visited'), visitedLine: cssVar('--visited-line'),
    stopover: cssVar('--stopover'), stopoverLine: cssVar('--stopover-line'),
    route: cssVar('--route'), routeOn: cssVar('--route-on'),
    marker: cssVar('--marker'), markerLine: cssVar('--marker-line'), markerOn: cssVar('--marker-on')
  };
}

function initMap() {
  if (typeof maplibregl === 'undefined') return false;
  const p = mapPaint();
  try {
    mapgl = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        projection: { type: 'globe' },
        sources: {
          countries: { type: 'geojson', data: worldGeoJSON({}) },
          routes: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'key' },
          airports: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'code' }
        },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': p.ocean } },
          { id: 'countries-fill', type: 'fill', source: 'countries', paint: { 'fill-color': p.land } },
          { id: 'countries-line', type: 'line', source: 'countries', filter: ['!=', ['get', 'status'], 'stopover'], paint: { 'line-color': p.landLine, 'line-width': 0.6 } },
          { id: 'stopover-line', type: 'line', source: 'countries', filter: ['==', ['get', 'status'], 'stopover'], paint: { 'line-color': p.stopoverLine, 'line-width': 1, 'line-dasharray': [2, 2] } },
          { id: 'routes', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': p.route, 'line-width': ['interpolate', ['linear'], ['zoom'], 0.5, ['*', 0.55, ['min', 6, ['+', 1.5, ['*', 0.5, ['get', 'n']]]]], 3.5, ['min', 6, ['+', 1.5, ['*', 0.5, ['get', 'n']]]]], 'line-opacity': 0.8 } },
          { id: 'routes-hit', type: 'line', source: 'routes', paint: { 'line-color': '#000', 'line-width': 14, 'line-opacity': 0 } },
          { id: 'airports', type: 'circle', source: 'airports', paint: { 'circle-color': p.marker, 'circle-stroke-color': p.markerLine, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 0.5, 1.5, 3.5, 2.5], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 0.5, ['*', 0.5, ['min', 15, ['+', 5, ['*', 1.6, ['sqrt', ['get', 'n']]]]]], 3.5, ['min', 15, ['+', 5, ['*', 1.6, ['sqrt', ['get', 'n']]]]]] } }
        ]
      },
      center: [15, 45], zoom: 2.5, minZoom: 0.6, maxZoom: 9,
      dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
      renderWorldCopies: true,
      cooperativeGestures: false,   // one finger moves the map; on a phone the map is shorter so the page stays easy to scroll
      attributionControl: { compact: true, customAttribution: 'Fond : <a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a>' },
      locale: {
        'NavigationControl.ZoomIn': 'Zoom avant', 'NavigationControl.ZoomOut': 'Zoom arrière',
        'GlobeControl.Enable': 'Voir le globe', 'GlobeControl.Disable': 'Voir la carte à plat',
        'CooperativeGesturesHandler.MobileHelpText': 'Utilisez deux doigts pour déplacer la carte',
        'CooperativeGesturesHandler.WindowsHelpText': 'Ctrl + molette pour zoomer',
        'CooperativeGesturesHandler.MacHelpText': '⌘ + molette pour zoomer',
        'AttributionControl.ToggleAttribution': 'Sources'
      }
    });
  } catch (e) {
    mapgl = null;
    return false;
  }
  mapgl.touchZoomRotate.disableRotation();   // pinch zooms, without turning the map
  mapgl.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  mapgl.addControl(new maplibregl.GlobeControl(), 'top-left');
  mapgl.addControl({
    onAdd() {
      const box = document.createElement('div');
      box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      box.innerHTML = '<button type="button" class="map-fit" title="Voir tous les vols" aria-label="Voir tous les vols">⤢</button>';
      box.querySelector('button').onclick = () => fitMap(true);
      return box;
    },
    onRemove() {}
  }, 'top-left');


  hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'map-tip', offset: 10 });
  const hover = (layer, html) => {
    mapgl.on('mousemove', layer, e => {
      mapgl.getCanvas().style.cursor = 'pointer';
      if (!coarsePointer()) hoverPopup.setLngLat(e.lngLat).setHTML(html(e.features[0].properties)).addTo(mapgl);
    });
    mapgl.on('mouseleave', layer, () => { mapgl.getCanvas().style.cursor = ''; hoverPopup.remove(); });
  };
  hover('airports', p => `<b>${esc(p.code)}</b> ${esc(city(p.code))}`);
  hover('routes-hit', p => `${esc(p.a)} ↔ ${esc(p.b)} · ${plural(p.n, 'vol', 'vols')}`);

  // One click handler: the airport wins over the route under it, empty sea or land closes the panel
  mapgl.on('click', e => {
    const hit = mapgl.queryRenderedFeatures(e.point, { layers: ['airports', 'routes-hit'] });
    const ap = hit.find(f => f.layer.id === 'airports'), rt = hit.find(f => f.layer.id === 'routes-hit');
    hoverPopup.remove();
    if (ap) showAirportPanel(ap.properties.code);
    else if (rt) showRoutePanel(rt.properties.key);
    else closeMapPanel();
  });

  // The style is inline, so "load" can come very early: also accept "styledata" and "idle"
  const ready = () => {
    if (mapReady || !mapgl.isStyleLoaded()) return;
    mapReady = true;
    const q = mapReadyQueue; mapReadyQueue = [];
    q.forEach(fn => fn());
  };
  ['load', 'styledata', 'idle'].forEach(ev => mapgl.on(ev, ready));
  // Events can be missed when the page is in the background: check a few times as well
  let tries = 0;
  const poll = setInterval(() => { ready(); if (mapReady || ++tries > 100) clearInterval(poll); }, 100);
  return true;
}
function whenMapReady(fn) {
  if (mapReady || (mapgl && mapgl.isStyleLoaded())) { mapReady = true; fn(); }
  else mapReadyQueue.push(fn);
}

let mapYear = '';   // '' = every year
function mapFlights() { return mapYear ? flights.filter(f => f.date.startsWith(mapYear)) : flights; }
function usedAirports() {
  return [...new Set(mapFlights().flatMap(f => [f.from, f.to]))].filter(c => AIRPORTS[c]);
}

function fitMap(force) {
  if (!mapgl) return;
  const codes = usedAirports();
  const key = [...codes].sort().join(',');
  if (!force && key === fittedFor) return;
  fittedFor = key;
  if (!codes.length) { mapgl.jumpTo({ center: [15, 45], zoom: 2.5 }); return; }
  if (codes.length === 1) { const a = AIRPORTS[codes[0]]; mapgl.easeTo({ center: [a.lon, a.lat], zoom: 5 }); return; }
  const lons = codes.map(c => AIRPORTS[c].lon), lats = codes.map(c => AIRPORTS[c].lat);
  const wide = window.innerWidth > 768 && !$('map-panel').hidden;
  mapgl.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
    padding: window.innerWidth <= 560 ? 24 : { top: 50, left: 50, bottom: 50, right: wide ? 380 : 50 }, maxZoom: 5, duration: force ? 800 : 0
  });
}

function renderMap() {
  renderMapHeader();
  if (!mapgl && !initMap()) {
    $('map').innerHTML = '<div class="empty-state"><p>La carte ne peut pas s\'afficher sur cet appareil (WebGL indisponible ou pas de connexion internet).</p></div>';
    return;
  }
  mapgl.resize();
  whenMapReady(() => {
    const p = mapPaint();
    // Colors follow the theme
    mapgl.setPaintProperty('ocean', 'background-color', p.ocean);
    mapgl.setPaintProperty('countries-fill', 'fill-color', ['match', ['get', 'status'], 'visited', p.visited, 'stopover', p.stopover, p.land]);
    mapgl.setPaintProperty('countries-line', 'line-color', ['match', ['get', 'status'], 'visited', p.visitedLine, p.landLine]);
    mapgl.setPaintProperty('stopover-line', 'line-color', p.stopoverLine);
    mapgl.setPaintProperty('airports', 'circle-color', ['case', ['boolean', ['feature-state', 'main'], false], p.markerOn, p.marker]);
    mapgl.setPaintProperty('airports', 'circle-stroke-color', p.markerLine);
    mapgl.setPaintProperty('airports', 'circle-opacity', ['case', ['boolean', ['feature-state', 'dim'], false], 0.3, 1]);
    mapgl.setPaintProperty('airports', 'circle-stroke-opacity', ['case', ['boolean', ['feature-state', 'dim'], false], 0.3, 1]);
    mapgl.setPaintProperty('routes', 'line-color', ['case', ['boolean', ['feature-state', 'on'], false], p.routeOn, p.route]);
    mapgl.setPaintProperty('routes', 'line-opacity', ['case', ['boolean', ['feature-state', 'dim'], false], 0.12, ['boolean', ['feature-state', 'on'], false], 1, 0.8]);

    // Countries with the passport rules
    const info = countryInfo(), status = {};
    info.visited.forEach(r => { status[r.cc] = 'visited'; });
    info.stopover.forEach(r => { status[r.cc] = 'stopover'; });
    mapgl.getSource('countries').setData(worldGeoJSON(status));

    // One line per pair of airports, both directions together
    const routes = {};
    mapFlights().forEach(f => {
      if (!AIRPORTS[f.from] || !AIRPORTS[f.to]) return;
      const k = routeKey(f.from, f.to);
      (routes[k] = routes[k] || { a: f.from, b: f.to, n: 0 }).n++;
    });
    routeKeys = new Set(Object.keys(routes));
    mapgl.getSource('routes').setData({
      type: 'FeatureCollection',
      features: Object.entries(routes).map(([k, r]) => {
        const A = AIRPORTS[r.a], B = AIRPORTS[r.b];
        return { type: 'Feature', properties: { key: k, a: r.a, b: r.b, n: r.n },
          geometry: { type: 'LineString', coordinates: greatCirclePoints(A.lat, A.lon, B.lat, B.lon, 64).map(([la, lo]) => [lo, la]) } };
      })
    });

    const counts = {};
    mapFlights().forEach(f => { counts[f.from] = (counts[f.from] || 0) + 1; counts[f.to] = (counts[f.to] || 0) + 1; });
    airportCodes = new Set(usedAirports());
    mapgl.getSource('airports').setData({
      type: 'FeatureCollection',
      features: [...airportCodes].sort((a, b) => counts[a] - counts[b]).map(code => ({
        type: 'Feature', properties: { code, n: counts[code] },
        geometry: { type: 'Point', coordinates: [AIRPORTS[code].lon, AIRPORTS[code].lat] }
      }))
    });

    fitMap(false);
    if (mapSelection) reopenMapPanel(); else applyHighlight();
  });
}

// ─── Map tab: header, year filter and the four extreme airports ───
const EXT_LABEL = { n: 'Le plus au nord', s: 'Le plus au sud', e: 'Le plus à l\'est', w: 'Le plus à l\'ouest' };
function renderMapHeader() {
  const aps = usedAirports();
  const routes = new Set(mapFlights().map(f => routeKey(f.from, f.to)));
  const info = countryInfo();
  // The country count is for the whole logbook, so it is shown only when every year is on the map
  $('map-summary').textContent = `${plural(aps.length, 'aéroport', 'aéroports')} · ${plural(routes.size, 'trajet', 'trajets')}${mapYear ? ' en ' + mapYear : ' · ' + plural(info.visited.length, 'pays visité', 'pays visités')}`;
  const years = [...new Set(flights.map(f => f.date.slice(0, 4)))].sort().reverse();
  if (mapYear && !years.includes(mapYear)) mapYear = '';
  $('map-years').innerHTML = ['', ...years].map(y => `<button type="button" class="pill${y === mapYear ? ' on' : ''}" data-map-year="${esc(y)}" aria-pressed="${y === mapYear}">${y ? esc(y) : 'Toutes les années'}</button>`).join('');

  // Farthest north, south, east and west among the airports on the map
  const pick = better => aps.reduce((best, c) => (!best || better(AIRPORTS[c], AIRPORTS[best])) ? c : best, null);
  const lat = a => `${Math.abs(a.lat).toFixed(1)}° ${a.lat >= 0 ? 'N' : 'S'}`;
  const lon = a => `${Math.abs(a.lon).toFixed(1)}° ${a.lon >= 0 ? 'E' : 'O'}`;
  const ext = [
    ['n', '↑', pick((a, b) => a.lat > b.lat), lat],
    ['s', '↓', pick((a, b) => a.lat < b.lat), lat],
    ['e', '→', pick((a, b) => a.lon > b.lon), lon],
    ['w', '←', pick((a, b) => a.lon < b.lon), lon]
  ];
  $('map-extremes').innerHTML = aps.length ? ext.map(([k, arrow, code, coord]) => `<button type="button" class="ext" data-ext-airport="${esc(code)}">
      <span class="ext-dir"><i aria-hidden="true">${arrow}</i>${EXT_LABEL[k]}</span>
      <b>${esc(code)}</b><span class="ext-city">${esc(city(code))}, ${esc(countryName(AIRPORTS[code].country))}</span>
      <span class="ext-coord">${coord(AIRPORTS[code])}</span>
    </button>`).join('') : '';
}

function focusAirport(code) {
  const ap = AIRPORTS[code];
  if (!ap || !mapgl) return;
  showAirportPanel(code);
  const wide = window.innerWidth > 768;
  whenMapReady(() => mapgl.easeTo({ center: [ap.lon, ap.lat], zoom: Math.max(mapgl.getZoom(), 4), offset: wide ? [-180, 0] : [0, -Math.round(window.innerHeight * 0.2)], duration: 900 }));   // offset: keep the airport visible beside the panel
  if (!wide) $('map-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Dims everything not linked to the selected airport or route
function applyHighlight() {
  if (!mapgl || !mapReady) return;
  const sel = mapSelection;
  const linked = new Set();
  if (sel?.type === 'airport') {
    linked.add(sel.code);
    routeKeys.forEach(k => { const [a, b] = k.split('-'); if (a === sel.code) linked.add(b); if (b === sel.code) linked.add(a); });
  } else if (sel?.type === 'route') sel.key.split('-').forEach(c => linked.add(c));
  routeKeys.forEach(k => {
    const on = !!sel && (sel.type === 'airport' ? k.split('-').includes(sel.code) : k === sel.key);
    mapgl.setFeatureState({ source: 'routes', id: k }, { on, dim: !!sel && !on });
  });
  airportCodes.forEach(code => {
    const on = !sel || linked.has(code);
    const main = !!sel && (sel.type === 'airport' ? code === sel.code : linked.has(code));
    mapgl.setFeatureState({ source: 'airports', id: code }, { dim: !on, main });
  });
}

// ─── Side panel (bottom sheet on a phone) ───
function flightRows(list, here) {
  return `<ul class="mp-flights">${list.map(f => {
    const code = c => `<span class="${c === here ? 'mp-here' : ''}">${esc(c)}</span>`;
    return `<li><button type="button" data-flight="${esc(f.id)}">
      <span class="mp-date">${formatDate(f.date)}</span>
      <span class="mp-route">${code(f.from)} → ${code(f.to)}</span>
      <span class="mp-meta">${esc([f.airline, f.flightNumber].filter(Boolean).join(' · '))}</span>
    </button></li>`;
  }).join('')}</ul>`;
}
const byDateDesc = (a, b) => (b.date + b.departureTime).localeCompare(a.date + a.departureTime);

function openMapPanel(html, sel) {
  mapSelection = sel;
  const p = $('map-panel');
  $('map-panel-body').innerHTML = html;
  const wasHidden = p.hidden;
  p.hidden = false;
  document.body.classList.add('sheet-open');
  $('map-panel-body').scrollTop = 0;
  applyHighlight();
  // On a phone the panel covers the bottom of the screen: bring the map to the top so the highlight stays visible
  if (wasHidden && window.innerWidth <= 768) {
    const top = $('map-container').getBoundingClientRect().top - document.querySelector('header').offsetHeight - 8;
    if (Math.abs(top) > 40) window.scrollBy({ top, behavior: 'smooth' });
  }
}
function closeMapPanel() {
  if ($('map-panel').hidden && !mapSelection) return;
  $('map-panel').hidden = true;
  document.body.classList.remove('sheet-open');
  mapSelection = null;
  applyHighlight();
}
function reopenMapPanel() {
  const s = mapSelection;
  if (s.type === 'airport' && airportCodes.has(s.code)) showAirportPanel(s.code);
  else if (s.type === 'route' && routeKeys.has(s.key)) showRoutePanel(s.key);
  else closeMapPanel();
}

function showAirportPanel(code) {
  const ap = AIRPORTS[code];
  if (!ap) return;
  const list = flights.filter(f => f.from === code || f.to === code).sort(byDateDesc);
  const deps = list.filter(f => f.from === code).length;
  const links = {};
  list.forEach(f => { const o = f.from === code ? f.to : f.from; links[o] = (links[o] || 0) + 1; });
  const first = list[list.length - 1], last = list[0];
  openMapPanel(`
    <div class="mp-photo" data-airport-photo="${esc(code)}"></div>
    <div class="mp-head">
      <div class="mp-code">${esc(code)}</div>
      <div>
        <div class="mp-title">${esc(ap.name)}</div>
        <div class="mp-sub">${countryFlag(ap.country)} ${esc(ap.city)}, ${esc(countryName(ap.country))}</div>
      </div>
    </div>
    <div class="mp-stats">
      <div><b>${list.length}</b><span>${list.length > 1 ? 'passages' : 'passage'}</span></div>
      <div><b>${deps}</b><span>${deps > 1 ? 'départs' : 'départ'}</span></div>
      <div><b>${list.length - deps}</b><span>${list.length - deps > 1 ? 'arrivées' : 'arrivée'}</span></div>
    </div>
    ${first ? `<div class="mp-note">${list.length > 1 ? `Premier passage le ${formatDate(first.date)}, dernier le ${formatDate(last.date)}.` : `Passage le ${formatDate(first.date)}.`}</div>` : ''}
    <div class="mp-label">Liaisons</div>
    <div class="mp-chips">${Object.entries(links).sort((a, b) => b[1] - a[1]).map(([o, n]) =>
      `<button type="button" class="mp-chip" data-route="${esc(routeKey(code, o))}"><b>${esc(o)}</b> ${esc(city(o))} <span>×${n}</span></button>`).join('')}</div>
    <div class="mp-label">Vols</div>
    ${flightRows(list, code)}`, { type: 'airport', code });
  loadAirportPhoto(code);
}

// ─── Airport photo: the main image of the airport on Wikidata, served by Wikimedia Commons ───
const airportPhotoCache = new Map();   // IATA code -> Promise of { src, page, credit } or null

function plainText(html) {
  return (new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim();
}

function fetchAirportPhoto(code) {
  if (airportPhotoCache.has(code)) return airportPhotoCache.get(code);
  const job = (async () => {
    if (!/^[A-Z0-9]{3}$/.test(code)) return null;
    const query = `SELECT ?img WHERE { ?a wdt:P238 "${code}" ; wdt:P18 ?img . } LIMIT 1`;
    const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, { headers: { Accept: 'application/sparql-results+json' } });
    if (!r.ok) return null;
    const url = (await r.json())?.results?.bindings?.[0]?.img?.value;
    if (!url) return null;
    const file = decodeURIComponent(url.split('/').pop());
    const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=imageinfo&iiprop=url%7Cextmetadata'
      + '&iiurlwidth=800&iiextmetadatafilter=Artist%7CLicenseShortName&titles=' + encodeURIComponent('File:' + file);
    const m = await fetch(api);
    if (!m.ok) return null;
    const info = Object.values((await m.json())?.query?.pages || {})[0]?.imageinfo?.[0];
    const src = info?.thumburl || info?.url;
    if (!src || !/^https:\/\/[a-z.]*wikimedia\.org\//.test(src)) return null;
    const page = /^https:\/\/commons\.wikimedia\.org\//.test(info.descriptionurl || '') ? info.descriptionurl : 'https://commons.wikimedia.org';
    const artist = plainText(info.extmetadata?.Artist?.value), license = plainText(info.extmetadata?.LicenseShortName?.value);
    return { src, page, credit: [artist, license].filter(Boolean).join(' · ') };
  })().catch(() => null);
  airportPhotoCache.set(code, job);
  // A failed lookup may be retried later (for example after a network error)
  job.then(res => { if (!res) setTimeout(() => airportPhotoCache.delete(code), 60000); });
  return job;
}

async function loadAirportPhoto(code) {
  const box = () => document.querySelector(`#map-panel-body [data-airport-photo="${code}"]`);
  if (!box()) return;
  const res = await fetchAirportPhoto(code);
  const el = box();
  if (!el) return;
  if (!res) { el.remove(); return; }
  const img = new Image();
  img.alt = `Photo de l'aéroport ${code}`;
  img.onload = () => el.classList.add('loaded');
  img.onerror = () => el.remove();
  img.src = res.src;
  const credit = document.createElement('a');
  credit.className = 'credit';
  credit.href = res.page; credit.target = '_blank'; credit.rel = 'noopener';
  credit.textContent = `Photo : ${res.credit || 'auteur inconnu'} · Wikimedia Commons`;
  el.replaceChildren(img, credit);
}

function showRoutePanel(key) {
  const [a, b] = key.split('-');
  const list = flights.filter(f => routeKey(f.from, f.to) === key).sort(byDateDesc);
  if (!list.length) return closeMapPanel();
  const airlines = [...new Set(list.map(f => f.airline).filter(Boolean))];
  const durs = list.map(f => f.durationMin).filter(m => m > 0);
  const avg = durs.length ? Math.round(durs.reduce((s, m) => s + m, 0) / durs.length) : 0;
  openMapPanel(`
    <div class="mp-head">
      <div class="mp-code mp-code-route">${esc(a)}<span>↔</span>${esc(b)}</div>
    </div>
    <div class="mp-sub" style="margin:-4px 0 12px">
      <button type="button" class="mp-link" data-airport="${esc(a)}">${esc(city(a))}</button> ↔
      <button type="button" class="mp-link" data-airport="${esc(b)}">${esc(city(b))}</button>
    </div>
    <div class="mp-stats">
      <div><b>${list.length}</b><span>${list.length > 1 ? 'vols' : 'vol'}</span></div>
      <div><b>${fmtInt(getDistance(a, b))}</b><span>km</span></div>
      <div><b>${avg ? fmtDur(avg) : '–'}</b><span>durée moyenne</span></div>
    </div>
    ${airlines.length ? `<div class="mp-note">${esc(airlines.join(', '))}</div>` : ''}
    <div class="mp-label">Vols</div>
    ${flightRows(list)}`, { type: 'route', key });
}

// ═══════════════════════════════════════
//  JOURNAL
// ═══════════════════════════════════════
// Flights are grouped into trips: a trip starts when leaving home (the most
// used airport) and ends when coming back. A stop left the same day it was
// reached is a connection ("via"), not a destination.
function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000); }
function arrivalDay(f) { return f.arrivalDate || f.date; }

function buildTrips() {
  const counts = {};
  flights.forEach(f => [f.from, f.to].forEach(c => { counts[c] = (counts[c] || 0) + 1; }));
  const home = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const sorted = [...flights].sort((a, b) => (a.date + a.departureTime).localeCompare(b.date + b.departureTime));
  const trips = [];
  let cur = null;
  sorted.forEach(f => {
    const last = cur && cur[cur.length - 1];
    if (!last || last.to === home || f.from === home || daysBetween(arrivalDay(last), f.date) > 45) { cur = []; trips.push(cur); }
    cur.push(f);
  });
  return trips.map(list => {
    const places = [], via = [], stops = [];
    list.forEach((f, i) => {
      if (f.to === home) return;
      const next = list[i + 1];
      const transit = next && next.from === f.to && next.date === arrivalDay(f);
      const name = city(f.to);
      if (transit) { if (!via.includes(name)) via.push(name); }
      else if (!places.includes(name)) { places.push(name); stops.push(f.to); }
    });
    if (!places.length) list.forEach(f => { if (f.from !== home && !places.includes(city(f.from))) { places.push(city(f.from)); stops.push(f.from); } });
    const finalVia = via.filter(v => !places.includes(v));
    const countries = [...new Set(stops.map(c => AIRPORTS[c]?.country).filter(Boolean))];
    const people = [...new Set(list.flatMap(f => (f.coTravelers || '').split(',').map(p => p.trim()).filter(Boolean)))];
    return {
      flights: list, places, via: finalVia, countries, people,
      start: list[0].date, end: arrivalDay(list[list.length - 1]),
      km: list.reduce((s, f) => s + (f.distKm || 0), 0)
    };
  });
}

let journalYear = '';   // '' = every year

// The trip as a chain of airport codes: OSL → FRA → SIN … ; a connection (left the same day) is shown lighter
function itineraryHTML(list) {
  const parts = [];
  list.forEach((f, i) => {
    if (i === 0) parts.push(`<span>${esc(f.from)}</span>`);
    else if (list[i - 1].to !== f.from) parts.push('<em>…</em>', `<span>${esc(f.from)}</span>`);
    const next = list[i + 1];
    const transit = next && next.from === f.to && next.date === arrivalDay(f);
    parts.push(`<span class="${transit ? 'via' : ''}"${transit ? ' title="Correspondance"' : ''}>${esc(f.to)}</span>`);
  });
  return parts.join('<i aria-hidden="true">→</i>');
}

function renderJournal() {
  const el = $('journal');
  if (!flights.length) {
    $('journal-summary').textContent = '';
    $('journal-years').innerHTML = '';
    el.innerHTML = '<div class="empty-state"><div class="emoji">📔</div><p>Aucun vol pour l\'instant.</p><button class="btn btn-primary" onclick="openModal()">+ Ajouter le premier vol</button></div>';
    return;
  }
  const all = buildTrips().reverse();   // most recent trip first; flights inside a trip stay in order
  const years = [...new Set(all.map(t => t.start.slice(0, 4)))];
  if (journalYear && !years.includes(journalYear)) journalYear = '';
  const trips = journalYear ? all.filter(t => t.start.startsWith(journalYear)) : all;
  const nFlights = trips.reduce((s, t) => s + t.flights.length, 0);
  $('journal-summary').textContent = `${plural(trips.length, 'voyage', 'voyages')} · ${plural(nFlights, 'vol', 'vols')}${journalYear ? ' en ' + journalYear : ''}`;
  $('journal-years').innerHTML = ['', ...years].map(y => `<button type="button" class="pill${y === journalYear ? ' on' : ''}" data-journal-year="${esc(y)}" aria-pressed="${y === journalYear}">${y ? esc(y) : 'Toutes les années'}</button>`).join('');

  const byYear = {};
  trips.forEach(t => { (byYear[t.start.slice(0, 4)] = byYear[t.start.slice(0, 4)] || []).push(t); });

  el.innerHTML = Object.keys(byYear).sort().reverse().map(year => {
    const list = byYear[year];
    const n = list.reduce((s, t) => s + t.flights.length, 0);
    const km = list.reduce((s, t) => s + t.km, 0);
    return `<div class="j-year"><h2>${esc(year)}</h2><span>${plural(list.length, 'voyage', 'voyages')} · ${plural(n, 'vol', 'vols')} · ${fmtInt(km)} km</span></div>
      ${list.map(t => {
        const days = daysBetween(t.start, t.end) + 1;
        const dates = t.start === t.end ? formatDate(t.start) : `${formatDate(t.start)} → ${formatDate(t.end)}`;
        return `<article class="j-trip">
          <div class="j-trip-head">
            <div class="j-trip-title">${t.countries.length ? `<span class="j-trip-flags">${t.countries.map(countryFlag).join(' ')}</span>` : ''}${esc(t.places.join(' · '))}</div>
            <div class="j-itin">${itineraryHTML(t.flights)}</div>
            <div class="j-chips">
              <span>${dates}</span>
              ${days > 1 ? `<span>${days} jours</span>` : ''}
              <span>${plural(t.flights.length, 'vol', 'vols')}</span>
              <span>${fmtInt(t.km)} km</span>
              ${t.people.map(p => `<span class="person">${esc(p)}</span>`).join('')}
            </div>
          </div>
          <ol class="j-flights">${t.flights.map(f => `<li class="pass j-flight" data-flight="${esc(f.id)}" tabindex="0" role="button" aria-label="Voir le vol ${esc(f.from)} vers ${esc(f.to)} du ${formatDate(f.date)}">
              <div class="pass-main">
                <div class="pass-top"><span>${formatDate(f.date)}${f.departureTime ? ' · ' + esc(f.departureTime) : ''}${f.photo ? ' <span class="has-photo" title="Photo dans la fiche du vol" aria-label="avec photo">📷</span>' : ''}</span><span>${esc([f.airline, f.flightNumber].filter(Boolean).join(' '))}</span></div>
                <div class="pass-route"><b>${esc(f.from)}</b><span class="line"></span><b>${esc(f.to)}</b></div>
                <div class="pass-cities"><span>${esc(city(f.from))}</span><span>${esc(city(f.to))}</span></div>
                ${f.notes ? `<p class="j-notes">${esc(f.notes)}</p>` : ''}
              </div>
              <div class="stub">
                <div><div class="k">siège</div><div class="v">${esc(f.seat || '–')}</div></div>
                <div><div class="k">durée</div><div class="v sm">${f.durationMin ? fmtDur(f.durationMin) : '–'}</div></div>
                ${f.aircraftType ? `<div><div class="k">avion</div><div class="t">${esc(f.aircraftType)}</div></div>` : ''}
              </div>
            </li>`).join('')}</ol>
        </article>`;
      }).join('')}`;
  }).join('');
}

// ═══════════════════════════════════════
//  ANALYTICS
// ═══════════════════════════════════════
let yearMode = 'flights';   // what the year chart shows: flights, km or hours

function renderAnalytics() {
  charts.forEach(c => c.destroy());
  charts = [];
  const container = $('charts-container');
  if (!flights.length) {
    container.innerHTML = '<div class="empty-state"><div class="emoji">📊</div><p>Ajoutez des vols pour voir les statistiques.</p></div>';
    return;
  }

  const byYear = {}, byAirline = {}, byAirport = {}, byRoute = {}, byAircraft = {}, byMonth = Array(12).fill(0);
  flights.forEach(f => {
    const y = f.date.slice(0, 4);
    const Y = byYear[y] = byYear[y] || { flights: 0, km: 0, hours: 0 };
    Y.flights++; Y.km += f.distKm || 0; Y.hours += (f.durationMin || 0) / 60;
    byMonth[+f.date.slice(5, 7) - 1]++;
    if (f.airline) byAirline[f.airline] = (byAirline[f.airline] || 0) + 1;
    if (f.from) byAirport[f.from] = (byAirport[f.from] || 0) + 1;
    if (f.to) byAirport[f.to] = (byAirport[f.to] || 0) + 1;
    if (f.from && f.to) { const k = [f.from, f.to].sort().join('↔'); byRoute[k] = (byRoute[k] || 0) + 1; }
    const ac = f.aircraftType || f.registration;
    if (ac) byAircraft[ac] = (byAircraft[ac] || 0) + 1;
  });
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]);   // full lists; the first 8 show, the rest behind "Voir tout"
  // every year from the first flight to the last, even years without flights
  const ys = Object.keys(byYear).map(Number);
  const years = [];
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) years.push(String(y));
  const topAirlines = top(byAirline), topAirports = top(byAirport), topAircraft = top(byAircraft), topRoutes = top(byRoute);

  const km = flights.reduce((s, f) => s + (f.distKm || 0), 0);
  const timed = flights.filter(f => f.durationMin > 0);
  const avgDur = timed.length ? Math.round(timed.reduce((s, f) => s + f.durationMin, 0) / timed.length) : 0;
  const perYear = flights.length / years.length;
  const MONTHS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
  const MONTHS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const maxMonth = Math.max(...byMonth), topMonth = byMonth.indexOf(maxMonth);
  const first = flights.reduce((m, f) => f.date < m ? f.date : m, '9999');
  const rankCard = (id, title, sub, wide) => `<section class="st-card${wide ? ' st-wide' : ''}"><div class="st-card-head"><h2>${title}</h2><span>${sub}</span></div><ol class="top-list" id="${id}"></ol></section>`;

  container.innerHTML = `
    <div class="st-head">
      <h1 class="fl-title">Statistiques</h1>
      <span class="muted">${plural(flights.length, 'vol', 'vols')} depuis le ${formatDate(first)}</span>
    </div>

    <div class="st-avg">
      <div><b>${fmtInt(km / flights.length)} km</b><span>par vol en moyenne</span></div>
      <div><b>${avgDur ? fmtDur(avgDur) : '–'}</b><span>de vol en moyenne</span></div>
      <div><b>${perYear.toFixed(1)}</b><span>vols par an</span></div>
      <div><b>${MONTHS_LONG[topMonth]}</b><span>mois le plus fréquent (${maxMonth} vols)</span></div>
    </div>

    <section class="st-card st-wide">
      <div class="st-card-head">
        <h2>Au fil des années</h2>
        <div class="seg" role="tablist" aria-label="Valeur affichée">
          ${[['flights', 'Vols'], ['km', 'Kilomètres'], ['hours', 'Heures']].map(([k, l]) => `<button type="button" role="tab" data-year-mode="${k}" aria-selected="${yearMode === k}" class="${yearMode === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="st-chart"><canvas id="chart-year"></canvas></div>
    </section>

    <section class="st-card st-wide">
      <div class="st-card-head"><h2>Mois de départ</h2><span>tous les vols, toutes années</span></div>
      <div class="months">${byMonth.map((n, i) => `<div class="month${i === topMonth ? ' top' : ''}" title="${MONTHS_LONG[i]} : ${plural(n, 'vol', 'vols')}">
          <span class="mv">${n || ''}</span><span class="mb" style="height:${maxMonth ? Math.max(n ? 6 : 2, Math.round(n / maxMonth * 100)) : 2}%"></span><span class="ml">${MONTHS[i]}</span></div>`).join('')}</div>
    </section>

    <div class="st-grid">
      ${rankCard('top-airports', 'Aéroports', 'passages')}
      ${rankCard('top-routes', 'Trajets', 'vols, aller et retour')}
      ${topAirlines.length ? rankCard('top-airlines', 'Compagnies', 'vols') : ''}
      ${topAircraft.length ? rankCard('top-aircraft', 'Types d\'avion', 'vols') : ''}
    </div>

    <section class="st-card st-wide"><div class="st-card-head"><h2>Places à bord</h2><span>d'après le numéro de siège</span></div><div id="seat-summary"></div></section>`;

  if (typeof Chart !== 'undefined') {
    const val = y => Math.round((byYear[y] || {})[yearMode] || 0);
    charts.push(new Chart($('chart-year'), {
      type: 'bar',
      data: { labels: years, datasets: [{ data: years.map(val), backgroundColor: cssVar('--accent'), hoverBackgroundColor: cssVar('--passport'), borderRadius: 6, maxBarThickness: 46 }] },
      options: {
        responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${fmtInt(c.raw)} ${{ flights: 'vols', km: 'km', hours: 'h' }[yearMode]}` } } },
        scales: {
          x: { ticks: { color: cssVar('--text3'), font: { family: 'IBM Plex Mono' } }, grid: { display: false } },
          y: { ticks: { color: cssVar('--text3'), precision: 0, callback: v => fmtInt(v) }, grid: { color: cssVar('--border') }, border: { display: false }, beginAtZero: true }
        }
      }
    }));
  }

  const bar = (n, max, color) => `<div class="bar-wrap"><div class="bar" style="width:${(n / max * 100).toFixed(0)}%;background:${color}"></div></div>`;
  $('top-airports').innerHTML = topAirports.map(([c, n], i) => `<li>
      <span class="rank">${i + 1}</span>
      <span class="rk-code">${esc(c)}</span>
      <span class="rk-name">${esc(AIRPORTS[c]?.city || '')}</span>
      ${bar(n, topAirports[0][1], 'var(--accent)')}<span class="count">${n}</span>
    </li>`).join('');
  $('top-routes').innerHTML = topRoutes.map(([key, n], i) => {
    const [a, b] = key.split('↔');
    return `<li>
      <span class="rank">${i + 1}</span>
      <span class="rk-code">${esc(a)} ↔ ${esc(b)}</span>
      <span class="rk-name">${esc(city(a))} · ${esc(city(b))}</span>
      ${bar(n, topRoutes[0][1], 'var(--yellow)')}<span class="count">${n}</span>
    </li>`;
  }).join('');
  const simple = (id, data, color) => {
    if ($(id)) $(id).innerHTML = data.map(([name, n], i) => `<li>
      <span class="rank">${i + 1}</span><span class="rk-name rk-main">${esc(name)}</span>
      ${bar(n, data[0][1], color)}<span class="count">${n}</span>
    </li>`).join('');
  };
  simple('top-airlines', topAirlines, 'var(--green)');
  simple('top-aircraft', topAircraft, 'var(--purple)');
  ['top-airports', 'top-routes', 'top-airlines', 'top-aircraft'].forEach(id => addShowMore(id, 8));
  renderSeatSummary();
}

// Shows the first items of a list and a button for the rest. The choice is kept while the page is open.
const expandedLists = new Set();
function addShowMore(id, limit) {
  const ul = $(id);
  if (!ul) return;
  const items = [...ul.children].filter(el => !el.classList.contains('add'));
  if (items.length <= limit) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'more-btn';
  const apply = () => {
    const open = expandedLists.has(id);
    items.forEach((li, i) => { if (i >= limit) li.hidden = !open; });
    btn.textContent = open ? 'Voir moins' : `Voir tout (${items.length})`;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.onclick = () => { if (expandedLists.has(id)) expandedLists.delete(id); else expandedLists.add(id); apply(); };
  ul.after(btn);
  apply();
}

// Window, middle or aisle: the same letter means different places on different
// aircraft, so the cabin layout is chosen from the aircraft type.
const SEAT_LAYOUTS = {
  // 2 + 2 (Embraer E-Jets, ATR, Dash 8, CRJ). Letters are A C | D F, or A B | C D on some airlines
  regional: { window: 'AF', aisle: 'BCD', middle: '' },
  // 2 + 3 (Airbus A220)
  a220: { window: 'AF', aisle: 'CD', middle: 'E' },
  // 3 + 3 (A318 to A321, Boeing 737 and 757)
  narrow: { window: 'AF', aisle: 'CD', middle: 'BE' },
  // 3 + 3 + 3 (Boeing 787, Airbus A350)
  w333: { window: 'AK', aisle: 'CDFG', middle: 'BEHJ' },
  // 3 + 4 + 3 (Boeing 777 and 747, Airbus A380)
  w343: { window: 'AK', aisle: 'CDGH', middle: 'BEFJ' },
  // 2 + 4 + 2 or 2 + 3 + 2 (Airbus A330 and A340, Boeing 767)
  w242: { window: 'AKL', aisle: 'CDGH', middle: 'EF' }
};
function seatLayout(type) {
  const t = norm(type).replace(/\s+/g, '');
  if (/EMBRAER|^E1[79]\d|^E2|ERJ|EMB|ATR|DASH|DHC|Q400|CRJ/.test(t)) return SEAT_LAYOUTS.regional;
  if (/A220|CS[13]00|BCS/.test(t)) return SEAT_LAYOUTS.a220;
  if (/787|A350/.test(t)) return SEAT_LAYOUTS.w333;
  if (/777|747|A380/.test(t)) return SEAT_LAYOUTS.w343;
  if (/A33\d|A34\d|767/.test(t)) return SEAT_LAYOUTS.w242;
  return SEAT_LAYOUTS.narrow;
}
function seatPosition(f) {
  const m = (f.seat || '').trim().toUpperCase().match(/^(\d{1,3})([A-L])$/);
  if (!m) return null;
  const L = seatLayout(f.aircraftType), letter = m[2];
  const pos = L.window.includes(letter) ? 'window' : L.aisle.includes(letter) ? 'aisle' : L.middle.includes(letter) ? 'middle' : null;
  return { row: +m[1], letter, pos };
}

function renderSeatSummary() {
  const el = $('seat-summary');
  const seated = flights.map(f => ({ f, s: seatPosition(f) })).filter(x => x.s);
  if (!seated.length) {
    el.innerHTML = '<p class="muted" style="padding:8px 0">Aucun siège enregistré. Ajoutez le numéro de siège (ex. 14A) dans vos vols.</p>';
    return;
  }
  const count = { window: 0, middle: 0, aisle: 0 };
  seated.forEach(x => { if (x.s.pos) count[x.s.pos]++; });
  const classified = count.window + count.middle + count.aisle;
  const pct = n => classified ? Math.round(n / classified * 100) : 0;
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
  // A row of seats seen from above: window, middle, aisle, then the aisle itself
  const seat = (key, label) => `<div class="seat seat-${key}${key === best ? ' best' : ''}">
      <div class="seat-shape"><b>${count[key]}</b><span>${pct(count[key])} %</span></div>
      <div class="seat-label">${label}</div>
    </div>`;

  const bySeat = {};
  seated.forEach(x => { const k = x.s.row + x.s.letter; bySeat[k] = (bySeat[k] || 0) + 1; });
  const [favSeat, favN] = Object.entries(bySeat).sort((a, b) => b[1] - a[1])[0];
  const rows = seated.map(x => x.s.row);
  const avgRow = Math.round(rows.reduce((s, r) => s + r, 0) / rows.length);
  const missing = flights.length - seated.length;
  const unclassified = seated.length - classified;

  el.innerHTML = `<div class="seat-row">
      <div class="seat-window-frame" aria-hidden="true"></div>
      ${seat('window', 'côté hublot')}
      ${seat('middle', 'au milieu')}
      ${seat('aisle', 'côté couloir')}
      <div class="seat-aisle-gap" aria-hidden="true"><span>couloir</span></div>
    </div>
    <div class="seat-kpis">
      <div><span>Siège le plus fréquent</span><b class="mono">${esc(favSeat)}</b><small>${favN > 1 ? `${favN} fois` : ''}</small></div>
      <div><span>Rang moyen</span><b class="mono">${avgRow}</b><small>de ${Math.min(...rows)} à ${Math.max(...rows)}</small></div>
      <div><span>Sièges connus</span><b class="mono">${seated.length}</b><small>${missing ? `${plural(missing, 'vol', 'vols')} sans siège` : 'tous les vols'}</small></div>
    </div>
    ${unclassified ? `<p class="seat-note">${plural(unclassified, 'siège non classé', 'sièges non classés')} (lettre inattendue pour ce type d'avion).</p>` : ''}
    <p class="seat-note">La position dépend de la cabine : sur un Embraer, la lettre B est côté couloir ; sur un Boeing 737, c'est la place du milieu.</p>`;
}

// ═══════════════════════════════════════
//  ADD / EDIT
// ═══════════════════════════════════════
function airportLabel(code) { return AIRPORTS[code] ? `${code} · ${AIRPORTS[code].city}` : (code || ''); }

function setHint(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'form-hint' + (cls ? ' ' + cls : '');
}

function refreshDatalists() {
  const fill = (id, key) => {
    const counts = {};
    flights.forEach(f => { if (f[key]) counts[f[key]] = (counts[f[key]] || 0) + 1; });
    $(id).innerHTML = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map(v => `<option value="${esc(v)}">`).join('');
  };
  fill('airline-list', 'airline');
  fill('type-list', 'aircraftType');
}

function openModal(id) {
  $('flight-form').reset();
  ['from-code', 'to-code'].forEach(i => { $(i).value = ''; });
  ['from-list', 'to-list'].forEach(i => $(i).classList.remove('open'));
  setHint('duration-hint', ''); setHint('reg-status', ''); setHint('date-hint', '');
  setHint('fn-status', ''); clearTimeout(fnTimer); fnFound = null;
  $('flight-date').removeAttribute('min');
  $('remove-photo').value = '0';
  $('photo-preview').innerHTML = '';
  $('photo-filename').textContent = '';
  $('duration').dataset.auto = ''; $('aircraft-type').dataset.auto = '';
  refreshDatalists();

  const f = id ? flights.find(x => x.id === id) : null;
  if (id && !f) return;
  $('modal-title').textContent = f ? 'Modifier le vol' : 'Ajouter un vol';
  $('flight-id').value = f ? f.id : '';
  if (f) {
    $('from-input').value = airportLabel(f.from); $('from-code').value = f.from;
    $('to-input').value = airportLabel(f.to); $('to-code').value = f.to;
    $('flight-date').value = f.date;
    $('departure-time').value = f.departureTime;
    $('arrival-date').value = f.arrivalDate || '';
    $('arrival-time').value = f.arrivalTime;
    $('duration').value = fmtDur(f.durationMin);
    $('cabin-class').value = f.cabinClass;
    $('airline').value = f.airline;
    $('flight-number').value = f.flightNumber;
    $('registration').value = f.registration;
    $('aircraft-type').value = f.aircraftType;
    $('seat').value = f.seat;
    $('co-travelers').value = f.coTravelers;
    $('notes').value = f.notes;
    if (f.photo) {
      $('photo-filename').textContent = 'Photo actuelle';
      photoURL(f.photo).then(url => { if ($('flight-id').value === f.id && $('remove-photo').value === '0' && !$('flight-photo').files.length) showPhotoThumb(url); }).catch(() => {});
    }
  } else {
    $('flight-date').value = todayISO();
    $('aircraft-type').dataset.auto = '1';
  }
  $('flight-modal').classList.add('open');
}

// New flight in the other direction: airports swapped; airline, class and
// travel companions copied. Date, times, flight number, aircraft, seat and
// notes stay empty because they change on the way back.
function openReturnFlight(id) {
  const f = flights.find(x => x.id === id);
  if (!f) return;
  openModal();
  $('modal-title').textContent = `Vol retour ${f.to} → ${f.from}`;
  $('from-input').value = airportLabel(f.to); $('from-code').value = f.to;
  $('to-input').value = airportLabel(f.from); $('to-code').value = f.from;
  $('airline').value = f.airline;
  $('cabin-class').value = f.cabinClass;
  $('co-travelers').value = f.coTravelers;

  // The date is required and left empty on purpose, so it cannot be saved with a wrong date by mistake
  const outbound = f.arrivalDate || f.date;
  $('flight-date').value = '';
  $('flight-date').min = outbound;
  const existing = flights
    .filter(x => x.from === f.to && x.to === f.from && x.date >= outbound)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (existing && existing.date <= addDays(outbound, 90)) {
    setHint('date-hint', `Attention : un vol ${existing.from} → ${existing.to} existe déjà le ${formatDate(existing.date)}.`, 'red');
  } else {
    setHint('date-hint', `Aller le ${formatDate(f.date)}. Indiquez la date du retour.`);
  }
  setTimeout(() => $('flight-date').focus(), 50);
}

function closeModal(id) { $(id).classList.remove('open'); if (id === 'detail-modal') detailId = null; }
function closeModalOnOverlay(e, id) { if (e.target === $(id)) closeModal(id); }

function onDurationTyped() {
  const el = $('duration');
  el.dataset.auto = '';
  const txt = el.value.trim(), mins = parseDuration(txt);
  if (!txt) setHint('duration-hint', '');
  else if (mins == null) setHint('duration-hint', 'Format non reconnu. Exemples : 2h 05m, 2:05, 125 (minutes).', 'red');
  else setHint('duration-hint', `Saisie à la main : ${fmtDur(mins) || '0h 00m'}`);
}

const tzPending = new Set();

// The duration is computed from the local times and the time zone of each airport.
// Without both time zones nothing is computed: a wrong value is worse than an empty field.
function recalcDuration() {
  const depDate = $('flight-date').value, depTime = $('departure-time').value;
  const arrDateIn = $('arrival-date').value, arrTime = $('arrival-time').value;
  const from = $('from-code').value, to = $('to-code').value;
  if (!depDate || !depTime || !arrTime || !from || !to) return;

  const A = AIRPORTS[from], B = AIRPORTS[to];
  if (!A?.tz || !B?.tz) {
    if (tzPending.has(from) || tzPending.has(to)) setHint('duration-hint', 'Recherche du fuseau horaire…', 'loading');
    else setHint('duration-hint', 'Fuseau horaire inconnu pour un aéroport. Saisissez la durée à la main (ex. 2h 05m).');
    return;
  }
  const dep = localToUTCDate(depDate, depTime, A.tz);
  let arr = localToUTCDate(arrDateIn || depDate, arrTime, B.tz);
  let note = '';
  if (arr <= dep && !arrDateIn) {
    // No arrival date given and the arrival is before the departure: the flight lands the next day
    const next = addDays(depDate, 1);
    arr = localToUTCDate(next, arrTime, B.tz);
    $('arrival-date').value = next;
    note = ' Arrivée le lendemain : date d\'arrivée remplie.';
  }
  const mins = Math.round((arr - dep) / 60000);
  if (mins <= 0) { setHint('duration-hint', 'L\'arrivée doit être après le départ.', 'red'); return; }
  if (mins > 24 * 60) { setHint('duration-hint', 'Plus de 24 heures : vérifiez les dates et les heures.', 'red'); return; }
  $('duration').value = fmtDur(mins);
  $('duration').dataset.auto = '1';
  setHint('duration-hint', 'Calculée avec les fuseaux horaires ✓' + note, 'green');
}

async function saveFlight(e) {
  e.preventDefault();
  if (saving) return;
  const from = $('from-code').value, to = $('to-code').value;
  if (!AIRPORTS[from] || !AIRPORTS[to]) { showToast('Choisissez les deux aéroports dans la liste proposée.', true); return; }
  if (from === to) { showToast('Le départ et l\'arrivée ne peuvent pas être le même aéroport.', true); return; }
  const durText = $('duration').value.trim();
  const durationMin = durText ? parseDuration(durText) : null;
  if (durText && !durationMin) { showToast('La durée n\'est pas reconnue. Exemples : 2h 05m, 2:05.', true); return; }

  const id = $('flight-id').value || uid();
  const existing = flights.find(f => f.id === id);
  const cabinClass = $('cabin-class').value;
  let dist = getDistance(from, to);
  if (!dist && existing && existing.from === from && existing.to === to) dist = existing.distKm;

  const flight = normalizeFlight({
    id, from, to,
    date: $('flight-date').value,
    departureTime: $('departure-time').value,
    arrivalDate: $('arrival-date').value,
    arrivalTime: $('arrival-time').value,
    durationMin,
    airline: $('airline').value, flightNumber: normFlightNumber($('flight-number').value), cabinClass,
    registration: $('registration').value, aircraftType: $('aircraft-type').value,
    seat: $('seat').value.toUpperCase(), coTravelers: $('co-travelers').value, notes: $('notes').value,
    distKm: dist, co2kg: calcCO2(dist, cabinClass)
  });
  if (flight.arrivalDate === flight.date) flight.arrivalDate = null;
  const label = `${from}-${to} du ${formatDate(flight.date)}`;

  const removePhoto = $('remove-photo').value === '1';
  const file = $('flight-photo').files[0];
  const btn = $('save-btn');
  saving = true; btn.disabled = true; btn.textContent = 'Enregistrement…';
  let uploaded = null;
  try {
    if (!removePhoto && file) {
      let dataUrl;
      try { dataUrl = await resizeImage(file); }
      catch (err) { showToast('Cette image ne peut pas être lue. Essayez un autre fichier.', true); return; }
      setStatus('busy', 'Envoi de la photo…');
      uploaded = `photos/${id}-${Date.now().toString(36)}.jpg`;
      await uploadPhoto(uploaded, dataUrl, `Photo du vol ${label}`);
      flight.photo = uploaded;
    } else if (!removePhoto && existing?.photo) {
      flight.photo = existing.photo;
    }

    const ok = await commitChange(() => {
      const idx = flights.findIndex(f => f.id === id);
      if (idx >= 0) flights[idx] = flight; else flights.push(flight);
    }, `${existing ? 'Modification' : 'Ajout'} du vol ${label}`);
    if (!ok) { if (uploaded) deletePhoto(uploaded, `Retrait d'une photo non utilisée`); return; }

    if (existing?.photo && existing.photo !== flight.photo) deletePhoto(existing.photo, `Retrait de l'ancienne photo du vol ${label}`);
    closeModal('flight-modal');
    showToast(existing ? '✅ Vol modifié et enregistré.' : '✅ Vol ajouté et enregistré.');
    renderAll();
  } catch (err) {
    setStatus('error', err.message);
    showToast(`Non enregistré. ${err.message || ''}`, true);
  } finally {
    saving = false; btn.disabled = false; btn.textContent = 'Enregistrer';
  }
}

async function deleteFlight(id) {
  const f = flights.find(x => x.id === id);
  if (!f || saving) return;
  const label = `${f.from}-${f.to} du ${formatDate(f.date)}`;
  if (!confirm(`Supprimer le vol ${label} ?`)) return;
  saving = true;
  try {
    const ok = await commitChange(() => { flights = flights.filter(x => x.id !== id); }, `Suppression du vol ${label}`);
    if (!ok) return;
    if (f.photo) deletePhoto(f.photo, `Retrait de la photo du vol ${label}`);
    closeModal('detail-modal');
    showToast('🗑️ Vol supprimé.');
    renderAll();
  } finally { saving = false; }
}

// ═══════════════════════════════════════
//  WORLD AIRPORT LIST (OurAirports)
// ═══════════════════════════════════════
// 12.8 MB, so it is downloaded only when a search needs it, never at page load.
const extDb = { loaded: false, loading: false, failed: false };

function parseCSVLine(line) {
  const out = [];
  let field = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQuote && line[i + 1] === '"') { field += '"'; i++; } else inQuote = !inQuote; }
    else if (c === ',' && !inQuote) { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

async function loadExtAirDb() {
  if (extDb.loaded || extDb.loading) return;
  extDb.loading = true; extDb.failed = false;
  refreshOpenAirportLists();
  try {
    let csv = null;
    for (const url of ['https://davidmegginson.github.io/ourairports-data/airports.csv',
      'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv']) {
      try { const r = await fetch(url); if (r.ok) { csv = await r.text(); break; } } catch (e) {}
    }
    if (!csv) throw new Error('download');
    const lines = csv.split(/\r?\n/);
    const head = parseCSVLine(lines[0]);
    const col = n => head.indexOf(n);
    const iT = col('type'), iN = col('name'), iLat = col('latitude_deg'), iLon = col('longitude_deg'),
      iC = col('iso_country'), iM = col('municipality'), iI = col('iata_code');
    if ([iT, iN, iLat, iLon, iC, iM, iI].some(i => i < 0)) throw new Error('format');
    const VALID = new Set(['small_airport', 'medium_airport', 'large_airport']);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const c = parseCSVLine(lines[i]);
      if (!VALID.has(c[iT])) continue;
      const iata = (c[iI] || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{3}$/.test(iata) || AIRPORTS[iata]) continue;   // known airports keep their time zone
      const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]);
      if (isNaN(lat) || isNaN(lon)) continue;
      const name = (c[iN] || '').trim();
      AIRPORTS[iata] = { name, city: (c[iM] || '').trim() || name, country: (c[iC] || '').trim(), lat: +lat.toFixed(4), lon: +lon.toFixed(4), tz: null };
    }
    extDb.loaded = true;
  } catch (e) {
    extDb.failed = true;
  } finally {
    extDb.loading = false;
    refreshOpenAirportLists();
  }
}
function refreshOpenAirportLists() {
  ['from', 'to'].forEach(w => { if ($(w + '-list').classList.contains('open')) airportSearch(w); });
}

// ═══════════════════════════════════════
//  AIRPORT SEARCH
// ═══════════════════════════════════════
function airportSearch(which) {
  const input = $(which + '-input'), list = $(which + '-list');
  $(which + '-code').value = '';
  const q = norm(input.value).trim();
  if (q.length < 2) { list.classList.remove('open'); return; }

  const scored = [];
  for (const [code, ap] of Object.entries(AIRPORTS)) {
    const c = norm(ap.city), n = norm(ap.name);
    const score = code === q ? 100 : code.startsWith(q) ? 80 : c.startsWith(q) ? 50 : n.startsWith(q) ? 40
      : c.includes(q) ? 30 : n.includes(q) ? 20 : 0;
    if (score) scored.push({ score, code, ap });
  }
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, 12);

  let html = results.map(({ code, ap }) => `<div class="autocomplete-item" data-code="${esc(code)}">
      <span class="iata">${esc(code)}</span>${esc(ap.name)}<span class="city"> · ${esc([ap.city, ap.country].filter(Boolean).join(', '))}</span>
    </div>`).join('');
  if (extDb.loading) html += '<div class="autocomplete-item info">Chargement de la liste mondiale des aéroports…</div>';
  else if (extDb.failed) html += '<div class="autocomplete-item more" data-more="1">La liste mondiale ne se charge pas. Réessayer</div>';
  else if (!extDb.loaded) html += '<div class="autocomplete-item more" data-more="1">Chercher dans tous les aéroports du monde…</div>';
  else if (!results.length) html += '<div class="autocomplete-item info">Aucun aéroport trouvé</div>';
  list.innerHTML = html;
  list.classList.add('open');
  // Nothing in the short list: load the world list without waiting for a click
  if (!results.length && !extDb.loaded && !extDb.loading && !extDb.failed) loadExtAirDb();
}

function selectAirport(which, code) {
  const ap = AIRPORTS[code];
  if (!ap) return;
  $(which + '-input').value = airportLabel(code);
  $(which + '-code').value = code;
  $(which + '-list').classList.remove('open');
  if (!ap.tz) fetchAirportTimezone(code);
  recalcDuration();
}

// Airports from the world list come without a time zone. It is looked up once
// from the coordinates, then saved with the flight.
async function fetchAirportTimezone(code) {
  const ap = AIRPORTS[code];
  if (!ap || ap.tz || tzPending.has(code)) return;
  tzPending.add(code);
  try {
    const r = await fetch(`https://timeapi.io/api/timezone/coordinate?latitude=${ap.lat}&longitude=${ap.lon}`);
    const tz = r.ok ? (await r.json())?.timeZone : null;
    if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ap.tz = tz; }   // throws if the name is not a real zone
  } catch (e) {}
  tzPending.delete(code);
  recalcDuration();
}

// ═══════════════════════════════════════
//  AIRCRAFT TYPE FROM REGISTRATION
// ═══════════════════════════════════════
// Type codes (ICAO) written the same way as the types already in the logbook
const TYPE_NAMES = {
  A318: 'Airbus A318', A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321',
  A19N: 'Airbus A319neo', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo',
  A332: 'Airbus A330-2', A333: 'Airbus A330-3', A338: 'Airbus A330-8neo', A339: 'Airbus A330-9neo',
  A343: 'Airbus A340-3', A346: 'Airbus A340-6', A359: 'Airbus A350-9', A35K: 'Airbus A350-10',
  A388: 'Airbus A380-8', BCS1: 'Airbus A220-1', BCS3: 'Airbus A220-3',
  B737: 'Boeing B737-7', B738: 'Boeing B737-8', B739: 'Boeing B737-9',
  B37M: 'Boeing B737-7 MAX', B38M: 'Boeing B737-8 MAX', B39M: 'Boeing B737-9 MAX',
  B744: 'Boeing B747-4', B748: 'Boeing B747-8', B752: 'Boeing B757-2', B753: 'Boeing B757-3',
  B763: 'Boeing B767-3', B764: 'Boeing B767-4', B772: 'Boeing B777-2', B77L: 'Boeing B777-2LR',
  B773: 'Boeing B777-3', B77W: 'Boeing B777-3ER', B788: 'Boeing B787-8', B789: 'Boeing B787-9', B78X: 'Boeing B787-10',
  E170: 'Embraer E170', E75L: 'Embraer E175', E75S: 'Embraer E175', E190: 'Embraer E190', E195: 'Embraer E195',
  E290: 'Embraer E190-E2', E295: 'Embraer E195-E2',
  AT72: 'ATR 72', AT75: 'ATR 72-500', AT76: 'ATR 72-600', AT45: 'ATR 42-500', AT46: 'ATR 42-600',
  DH8D: 'De Havilland Dash 8-400', CRJ9: 'Bombardier CRJ900', CRJX: 'Bombardier CRJ1000'
};

// ═══════════════════════════════════════
//  ROUTE FROM FLIGHT NUMBER
// ═══════════════════════════════════════
// adsbdb.com gives the route a flight number flies today. It fills only
// empty fields: an old flight may have used another route.
let fnTimer = null, fnFound = null;

function normFlightNumber(v) { return String(v || '').toUpperCase().replace(/\s+/g, ''); }

// Airline name as already written in the logbook for the same code (SK -> "SAS")
function airlineForCode(fn) {
  const code = fn.slice(0, 2), counts = {};
  flights.forEach(f => { if (f.airline && normFlightNumber(f.flightNumber).slice(0, 2) === code) counts[f.airline] = (counts[f.airline] || 0) + 1; });
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '';
}

function onFlightNumberInput() {
  clearTimeout(fnTimer);
  fnFound = null;
  const fn = normFlightNumber($('flight-number').value);
  if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(fn)) { setHint('fn-status', ''); return; }
  setHint('fn-status', '🔍 Recherche de la ligne…', 'loading');
  fnTimer = setTimeout(() => lookupFlightNumber(fn), 800);
}

async function lookupFlightNumber(fn) {
  const current = () => normFlightNumber($('flight-number').value) === fn && $('flight-modal').classList.contains('open');
  let route = null;
  try {
    const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(fn)}`);
    if (r.ok) route = (await r.json())?.response?.flightroute || null;
  } catch (e) {
    if (current()) setHint('fn-status', 'Service de recherche indisponible. Remplissez les champs à la main.');
    return;
  }
  if (!current()) return;
  const o = route?.origin, d = route?.destination;
  if (!o?.iata_code || !d?.iata_code) { setHint('fn-status', 'Ligne non trouvée pour ce numéro. Remplissez les champs à la main.'); return; }

  // Airports not in the built-in list are added from the answer; their time zone is looked up afterwards
  [o, d].forEach(a => {
    const code = String(a.iata_code).toUpperCase();
    if (!/^[A-Z0-9]{3}$/.test(code) || AIRPORTS[code] || !Number.isFinite(+a.latitude) || !Number.isFinite(+a.longitude)) return;
    AIRPORTS[code] = { name: String(a.name || code), city: String(a.municipality || a.name || code), country: String(a.country_iso_name || ''), lat: +(+a.latitude).toFixed(4), lon: +(+a.longitude).toFixed(4), tz: null };
  });
  const from = String(o.iata_code).toUpperCase(), to = String(d.iata_code).toUpperCase();
  const airline = airlineForCode(fn) || String(route.airline?.name || '');
  fnFound = { from, to, airline };

  const filled = [];
  if (!$('from-code').value && AIRPORTS[from]) { selectAirport('from', from); filled.push('départ'); }
  if (!$('to-code').value && AIRPORTS[to]) { selectAirport('to', to); filled.push('arrivée'); }
  if (!$('airline').value.trim() && airline) { $('airline').value = airline; filled.push('compagnie'); }

  const sameRoute = $('from-code').value === from && $('to-code').value === to;
  if (sameRoute) {
    setHint('fn-status', `✓ ${from} → ${to}${airline ? ' · ' + airline : ''}${filled.length ? ' (rempli : ' + filled.join(', ') + ')' : ''}`, 'green');
  } else {
    // Another route is already written: never replace it without asking
    const el = $('fn-status');
    el.className = 'form-hint';
    el.innerHTML = `Aujourd'hui, ${esc(fn)} relie ${esc(from)} → ${esc(to)}. C'était peut-être une autre ligne à l'époque. <a href="#" onclick="useFoundRoute();return false" style="color:var(--accent2)">Utiliser ${esc(from)} → ${esc(to)}</a>`;
  }
}

function useFoundRoute() {
  if (!fnFound) return;
  selectAirport('from', fnFound.from);
  selectAirport('to', fnFound.to);
  setHint('fn-status', `✓ ${fnFound.from} → ${fnFound.to}`, 'green');
}

let regTimer = null, foundType = '';

function onRegistrationInput() {
  clearTimeout(regTimer);
  const reg = $('registration').value.trim().toUpperCase();
  if (reg.length < 3) { setHint('reg-status', ''); return; }
  setHint('reg-status', '🔍 Recherche du type…', 'loading');
  regTimer = setTimeout(() => lookupAircraft(reg), 900);
}

async function lookupAircraft(reg) {
  const current = () => $('registration').value.trim().toUpperCase() === reg;
  const apply = (type, source) => {
    if (!current()) return;
    const field = $('aircraft-type');
    foundType = type;
    if (!field.value.trim() || field.dataset.auto === '1' || field.value.trim() === type) {
      field.value = type; field.dataset.auto = '1';
      setHint('reg-status', `✓ ${type} (${source})`, 'green');
    } else {
      // A type is already written: do not replace it without asking
      const el = $('reg-status');
      el.className = 'form-hint green';
      el.innerHTML = `Trouvé : ${esc(type)} (${esc(source)}). <a href="#" onclick="useFoundType();return false" style="color:var(--accent2)">Utiliser</a>`;
    }
  };

  // 1. The same aircraft already in the logbook
  const known = flights.find(f => f.registration === reg && f.aircraftType && f.id !== $('flight-id').value);
  if (known) { apply(known.aircraftType, 'déjà dans vos vols'); return; }

  // 2. adsbdb.com
  try {
    const r = await fetch(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(reg)}`);
    if (r.ok) {
      const a = (await r.json())?.response?.aircraft;
      const type = TYPE_NAMES[a?.icao_type] || [a?.manufacturer, a?.type].filter(Boolean).join(' ').trim();
      if (type) { apply(type, 'adsbdb.com'); return; }
    }
  } catch (e) {}

  // 3. planespotters.net, when the photo record names the aircraft
  try {
    const p = (await (await fetch(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`)).json()).photos?.[0];
    const type = `${p?.aircraft?.manufacturer || ''} ${p?.aircraft?.model || ''}`.trim();
    if (type) { apply(type, 'planespotters.net'); return; }
  } catch (e) {}

  if (current()) setHint('reg-status', 'Type non trouvé. Choisissez-le dans la liste ou écrivez-le.');
}
function useFoundType() {
  if (!foundType) return;
  $('aircraft-type').value = foundType; $('aircraft-type').dataset.auto = '1';
  setHint('reg-status', `✓ ${foundType}`, 'green');
}

// ═══════════════════════════════════════
//  PHOTOS IN THE FORM
// ═══════════════════════════════════════
function resizeImage(file, maxW = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function showPhotoThumb(url) {
  const wrap = document.createElement('div');
  wrap.className = 'photo-thumb';
  const img = new Image(); img.src = url; img.alt = '';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = '✕'; btn.title = 'Retirer la photo'; btn.onclick = clearPhoto;
  wrap.append(img, btn);
  $('photo-preview').replaceChildren(wrap);
}
function previewPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  $('photo-filename').textContent = file.name;
  $('remove-photo').value = '0';
  const reader = new FileReader();
  reader.onload = e => showPhotoThumb(e.target.result);
  reader.readAsDataURL(file);
}
function clearPhoto() {
  $('flight-photo').value = '';
  $('photo-preview').innerHTML = '';
  $('photo-filename').textContent = '';
  $('remove-photo').value = '1';
}

// ═══════════════════════════════════════
//  EXPORT / IMPORT
// ═══════════════════════════════════════
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportData() {
  if (!flights.length) { showToast('Aucun vol à exporter.', true); return; }
  download(new Blob([JSON.stringify(buildDoc(), null, 2)], { type: 'application/json' }), `carnet-de-vol-${todayISO()}.json`);
  showToast('📦 Fichier JSON exporté. Les photos restent dans le dépôt GitHub.');
}

async function exportExcel() {
  if (!flights.length) { showToast('Aucun vol à exporter.', true); return; }
  if (!await needXLSX()) return;
  const rows = [...flights].sort((a, b) => (b.date + b.departureTime).localeCompare(a.date + a.departureTime)).map(f => ({
    'Date': formatDate(f.date),
    'Départ': f.from, 'Ville de départ': AIRPORTS[f.from]?.city || '',
    'Arrivée': f.to, 'Ville d\'arrivée': AIRPORTS[f.to]?.city || '',
    'Compagnie': f.airline, 'N° de vol': f.flightNumber,
    'Immatriculation': f.registration, 'Type d\'avion': f.aircraftType,
    'Classe': CABIN_LABEL[f.cabinClass] || '',
    'Heure de départ': f.departureTime,
    'Date d\'arrivée': f.arrivalDate ? formatDate(f.arrivalDate) : '',
    'Heure d\'arrivée': f.arrivalTime,
    'Durée': fmtDur(f.durationMin),
    'Distance (km)': f.distKm || '',
    'CO2 (kg)': co2Of(f) || '',
    'Siège': f.seat, 'Voyagé avec': f.coTravelers, 'Notes': f.notes,
    'Photo': f.photo ? 'oui' : ''
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [12, 8, 16, 8, 16, 20, 10, 14, 22, 14, 10, 12, 10, 10, 12, 10, 6, 22, 40, 6].map(wch => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vols');
  XLSX.writeFile(wb, `carnet-de-vol-${todayISO()}.xlsx`);
  showToast('📊 Fichier Excel exporté (sans les photos).');
}

function handleImport(input) {
  const file = input.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  (ext === 'xlsx' || ext === 'xls' ? importExcel(file) : importJSON(file))
    .catch(err => showToast(`Import impossible. ${err.message || ''}`, true));
  input.value = '';
}

async function importJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { throw new Error('Ce fichier n\'est pas un fichier JSON valide.'); }
  const list = Array.isArray(data) ? data : data?.flights;
  if (!Array.isArray(list)) throw new Error('Ce fichier ne contient pas de liste de vols.');
  addAirports(data.airports);
  await mergeImported(list.map(normalizeFlight).filter(Boolean));
}

function parseAnyDate(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  const s = String(v ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{5}$/.test(s)) { const d = XLSX.SSF.parse_date_code(parseInt(s)); return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`; }
  return '';
}

async function importExcel(file) {
  if (!await needXLSX()) return;
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  if (!rows.length) throw new Error('Le fichier Excel est vide.');
  const cabinMap = {};
  Object.entries({ economy: ['economy', 'economy class', 'économique', 'eco'], premium: ['premium economy', 'premium eco', 'premium', 'premium éco'],
    business: ['business', 'business class', 'affaires'], first: ['first', 'first class', 'première'] })
    .forEach(([k, names]) => names.forEach(n => { cabinMap[n] = k; }));
  const list = rows.map(row => {
    const raw = keys => { for (const k of keys) if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return row[k]; return ''; };
    const g = keys => String(raw(keys)).trim();
    return normalizeFlight({
      from: g(['Départ', 'From', 'from']), to: g(['Arrivée', 'To', 'to']),
      date: parseAnyDate(raw(['Date', 'date'])),
      departureTime: g(['Heure de départ', 'Dep. Time', 'departureTime']),
      arrivalDate: parseAnyDate(raw(['Date d\'arrivée', 'Arr. Date', 'arrivalDate'])),
      arrivalTime: g(['Heure d\'arrivée', 'Arr. Time', 'arrivalTime']),
      duration: g(['Durée', 'Duration', 'duration']),
      airline: g(['Compagnie', 'Airline', 'airline']),
      flightNumber: g(['N° de vol', 'Flight #', 'flightNumber']),
      registration: g(['Immatriculation', 'Registration', 'registration']),
      aircraftType: g(['Type d\'avion', 'Aircraft Type', 'aircraftType']),
      cabinClass: cabinMap[g(['Classe', 'Cabin Class', 'cabinClass']).toLowerCase()] || 'economy',
      seat: g(['Siège', 'Seat', 'seat']),
      coTravelers: g(['Voyagé avec', 'Co-travelers', 'coTravelers']),
      notes: g(['Notes', 'notes']),
      distKm: parseFloat(g(['Distance (km)', 'distKm'])) || null,
      co2kg: parseFloat(g(['CO2 (kg)', 'CO₂ (kg)', 'co2kg'])) || null
    });
  });
  await mergeImported(list);
}

// An import only adds flights. It never replaces or removes the flights already saved.
async function mergeImported(list) {
  const incoming = list.filter(f => f.date && f.from && f.to);
  if (!incoming.length) throw new Error('Aucun vol valide dans ce fichier (il faut une date et deux aéroports).');
  const key = f => `${f.date}|${f.from}|${f.to}|${f.departureTime}`;
  const ids = new Set(flights.map(f => f.id)), keys = new Set(flights.map(key));
  const fresh = incoming.filter(f => !ids.has(f.id) && !keys.has(key(f)));
  if (!fresh.length) { showToast(`Rien à ajouter : les ${incoming.length} vols du fichier sont déjà dans le carnet.`); return; }
  if (!confirm(`Le fichier contient ${incoming.length} vol(s), dont ${fresh.length} nouveau(x).\n\nAjouter ${fresh.length} vol(s) ? Les vols déjà enregistrés ne changent pas.`)) return;

  if (fresh.some(f => !AIRPORTS[f.from] || !AIRPORTS[f.to])) await loadExtAirDb();
  setStatus('busy', 'Import en cours…');
  for (const f of fresh) {
    if (!f.distKm) f.distKm = getDistance(f.from, f.to) || null;
    if (!f.co2kg) f.co2kg = calcCO2(f.distKm, f.cabinClass) || null;
    if (f.photo && f.photo.startsWith('data:')) {
      const path = `photos/${f.id}.jpg`;
      try { await uploadPhoto(path, f.photo, `Photo du vol ${f.from}-${f.to} du ${formatDate(f.date)}`); f.photo = path; }
      catch (e) { f.photo = null; }
    }
  }
  const ok = await commitChange(() => { flights.push(...fresh); }, `Import de ${fresh.length} vol(s)`);
  if (ok) { showToast(`✅ ${fresh.length} vol(s) ajouté(s).`); renderAll(); }
}

// ═══════════════════════════════════════
//  START
// ═══════════════════════════════════════
document.addEventListener('click', e => {
  if (!e.target.closest('.autocomplete-wrap')) document.querySelectorAll('.autocomplete-list').forEach(l => l.classList.remove('open'));
  if (!e.target.closest('#menu')) $('menu').hidden = true;
});
['from', 'to'].forEach(which => {
  $(which + '-list').addEventListener('click', e => {
    const item = e.target.closest('.autocomplete-item');
    if (!item) return;
    if (item.dataset.code) selectAirport(which, item.dataset.code);
    else if (item.dataset.more) loadExtAirDb();
  });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = document.querySelectorAll('.modal-overlay.open');
  if (open.length) open.forEach(m => closeModal(m.id)); else closeMapPanel();
});
$('passport').addEventListener('click', e => {
  const stamp = e.target.closest('[data-country]');
  if (stamp) openCountrySheet(stamp.dataset.country);
});
$('stat-popup-body').addEventListener('click', e => {
  const b = e.target.closest('[data-set-status]');
  if (b && $('stat-popup-body').dataset.country) setCountryStatus($('stat-popup-body').dataset.country, b.dataset.setStatus);
});
$('view-journal').addEventListener('click', e => {
  const y = e.target.closest('[data-journal-year]');
  if (y) { journalYear = y.dataset.journalYear; renderJournal(); }
});
$('view-map').addEventListener('click', e => {
  const y = e.target.closest('[data-map-year]');
  if (y) { mapYear = y.dataset.mapYear; closeMapPanel(); renderMap(); return; }
  const x = e.target.closest('[data-ext-airport]');
  if (x) focusAirport(x.dataset.extAirport);
});
$('charts-container').addEventListener('click', e => {
  const b = e.target.closest('[data-year-mode]');
  if (b && b.dataset.yearMode !== yearMode) { yearMode = b.dataset.yearMode; renderAnalytics(); }
});
$('flights-table').addEventListener('click', e => {
  const item = e.target.closest('.fl');
  if (item) openFlightDetail(item.dataset.flight);
});
$('flights-table').addEventListener('keydown', e => {
  const item = e.target.closest('.fl');
  if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openFlightDetail(item.dataset.flight); }
});
$('journal').addEventListener('click', e => {
  const item = e.target.closest('.j-flight');
  if (item) openFlightDetail(item.dataset.flight);
});
$('journal').addEventListener('keydown', e => {
  const item = e.target.closest('.j-flight');
  if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openFlightDetail(item.dataset.flight); }
});
$('map-panel').addEventListener('click', e => {
  const t = e.target.closest('[data-flight],[data-route],[data-airport],.mp-close');
  if (!t) return;
  if (t.classList.contains('mp-close')) closeMapPanel();
  else if (t.dataset.flight) openFlightDetail(t.dataset.flight);
  else if (t.dataset.route) showRoutePanel(t.dataset.route);
  else if (t.dataset.airport) showAirportPanel(t.dataset.airport);
});

async function init() {
  updateThemeButton();
  cfg = readCfg();
  if (!cfg) { showSetup(); return; }
  showApp();
  const cached = readCache();
  if (cached?.doc) {
    try { applyDoc(cached.doc); dataSha = cached.sha || null; renderAll(); } catch (e) {}
  }
  await reloadData(true);
}
init();
