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
let dataSha = null;                  // version of flights.json this device last saw
let sortKey = 'date', sortDir = 1;
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
  return { schema: 1, airports, flights: sorted };
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
  const before = flights.slice();
  mutate();
  setStatus('busy', 'Enregistrement…');
  try {
    await persist(message);
    setStatus('ok');
    return true;
  } catch (e) {
    flights = before;
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
  $('app').hidden = true; $('header-actions').hidden = true; $('banner').hidden = true;
  $('setup').hidden = false;
  $('setup-error').textContent = message || '';
  if (!$('cfg-repo').value) {
    const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
    if (m) $('cfg-repo').value = `${m[1]}/carnet-de-vol-data`;
  }
}
function showApp() {
  $('setup').hidden = true; $('app').hidden = false; $('header-actions').hidden = false;
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
let leafletMap = null, mapLayers = [], charts = [];

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  renderAll();
}
function renderAll() {
  if ($('app').hidden) return;
  const active = document.querySelector('.view.active')?.id;
  if (active === 'view-dashboard') renderDashboard();
  else if (active === 'view-flights') renderFlightsTable();
  else if (active === 'view-journal') renderJournal();
  else if (active === 'view-analytics') renderAnalytics();
}
const city = code => AIRPORTS[code]?.city || code || '';

// ═══════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════
function renderDashboard() {
  const total = flights.length;
  const totalKm = flights.reduce((s, f) => s + (f.distKm || 0), 0);
  const totalCO2 = flights.reduce((s, f) => s + co2Of(f), 0);
  const totalMins = flights.reduce((s, f) => s + (f.durationMin || 0), 0);
  const logged = flights.filter(f => f.durationMin > 0).length;
  const airports = new Set(flights.flatMap(f => [f.from, f.to].filter(Boolean)));
  const countries = new Set(flights.flatMap(f => [AIRPORTS[f.from]?.country, AIRPORTS[f.to]?.country].filter(Boolean)));
  const thisYear = String(new Date().getFullYear());
  const nYear = flights.filter(f => f.date.startsWith(thisYear)).length;

  $('stats-grid').innerHTML = `
    <div class="stat-card" onclick="showView('flights')" title="Voir tous les vols">
      <div class="stat-icon">✈️</div>
      <div class="stat-label">Vols</div>
      <div class="stat-value">${total}</div>
      <div class="stat-sub">${nYear} cette année</div>
    </div>
    <div class="stat-card" onclick="showDistancePopup()" title="Voir les vols par distance">
      <div class="stat-icon">🌍</div>
      <div class="stat-label">Distance</div>
      <div class="stat-value">${totalKm > 999 ? (totalKm / 1000).toFixed(1) + 'k' : totalKm}</div>
      <div class="stat-sub">${fmtInt(totalKm)} km · ${(totalKm / 40075).toFixed(1)}× le tour de la Terre</div>
    </div>
    <div class="stat-card" onclick="showAirportsPopup()" title="Voir le détail par aéroport">
      <div class="stat-icon">🏢</div>
      <div class="stat-label">Aéroports</div>
      <div class="stat-value">${airports.size}</div>
      <div class="stat-sub">aéroports différents</div>
    </div>
    <div class="stat-card" onclick="showCountriesPopup()" title="Voir les pays">
      <div class="stat-icon">🗺️</div>
      <div class="stat-label">Pays</div>
      <div class="stat-value">${countries.size}</div>
      <div class="stat-sub">pays visités</div>
    </div>
    <div class="stat-card" onclick="showDurationPopup()" title="Voir les vols par durée">
      <div class="stat-icon">⏱️</div>
      <div class="stat-label">Temps en vol</div>
      <div class="stat-value">${fmtMins(totalMins)}</div>
      <div class="stat-sub">${logged} vol${logged !== 1 ? 's' : ''} sur ${total} avec une durée</div>
    </div>
    <div class="stat-card co2-card" onclick="showCO2Popup()" title="Voir les vols par CO₂">
      <div class="stat-icon">🌱</div>
      <div class="stat-label">CO₂e total</div>
      <div class="stat-value">${totalCO2 >= 1000 ? (totalCO2 / 1000).toFixed(1) + ' t' : totalCO2 + ' kg'}</div>
      <div class="stat-sub">estimation, forçage radiatif inclus</div>
    </div>`;
  renderMap();
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

function showCountriesPopup() {
  if (!flights.length) return;
  const by = {};
  flights.forEach(f => [AIRPORTS[f.from]?.country, AIRPORTS[f.to]?.country].filter(Boolean).forEach(cc => { by[cc] = (by[cc] || 0) + 1; }));
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([cc, n], i) => `<li>
      <span class="stat-popup-rank">${i + 1}</span>
      <span class="stat-popup-label">${countryFlag(cc)} ${esc(countryName(cc))}</span>
      <span class="stat-popup-value">${n} passage${n > 1 ? 's' : ''}</span>
    </li>`).join('');
  showStatPopup('🗺️ Pays', `<ul class="stat-popup-list">${rows}</ul>`);
}

function showCO2Popup() {
  if (!flights.length) return;
  const rows = [...flights].sort((a, b) => co2Of(b) - co2Of(a))
    .map((f, i) => flightLi(f, i, formatCO2(co2Of(f)), 'color:#86efac')).join('');
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
function renderFlightsTable() {
  updateYearFilter();
  // The class column and filter appear only when the logbook has more than one class
  const multiClass = new Set(flights.map(f => f.cabinClass)).size > 1;
  $('filter-class').hidden = !multiClass;
  if (!multiClass) $('filter-class').value = '';
  const search = norm($('search-input').value);
  const year = $('filter-year').value, cls = $('filter-class').value;

  const filtered = flights.filter(f => {
    const a = AIRPORTS[f.from] || {}, b = AIRPORTS[f.to] || {};
    const str = norm([f.from, f.to, f.airline, f.flightNumber, f.registration, f.aircraftType, a.city, b.city, a.name, b.name].join(' '));
    if (search && !str.includes(search)) return false;
    if (year && !f.date.startsWith(year)) return false;
    if (cls && f.cabinClass !== cls) return false;
    return true;
  });

  const val = f => sortKey === 'distKm' ? (f.distKm || 0)
    : sortKey === 'co2kg' ? co2Of(f)
    : sortKey === 'date' ? f.date + f.departureTime
    : norm(f[sortKey]);
  filtered.sort((a, b) => { const va = val(a), vb = val(b); return va < vb ? sortDir : va > vb ? -sortDir : 0; });

  const tbl = $('flights-table');
  if (!flights.length) {
    tbl.innerHTML = '<div class="empty-state"><div class="emoji">✈️</div><p>Aucun vol pour l\'instant.</p><button class="btn btn-primary" onclick="openModal()">+ Ajouter le premier vol</button></div>';
    return;
  }
  if (!filtered.length) {
    tbl.innerHTML = '<div class="empty-state"><div class="emoji">🔍</div><p>Aucun vol ne correspond à ces filtres.</p></div>';
    return;
  }
  const col = (key, label, cls = '') => `<th class="${cls}" onclick="sortBy('${key}')">${label}${sortKey === key ? (sortDir === 1 ? ' ↓' : ' ↑') : ''}</th>`;
  tbl.innerHTML = `<table>
    <thead><tr>
      ${col('date', 'Date')}
      <th>Trajet</th>
      ${col('airline', 'Compagnie')}
      <th class="col-wide">Avion</th>
      ${col('distKm', 'Distance')}
      ${col('co2kg', 'CO₂e', 'col-wide')}
      ${multiClass ? '<th class="col-wide">Classe</th>' : ''}
    </tr></thead>
    <tbody>${filtered.map(f => `<tr class="flight-row" tabindex="0" onclick="openFlightDetail('${f.id}')" onkeydown="if(event.key==='Enter')openFlightDetail('${f.id}')" title="Voir, modifier ou supprimer ce vol">
      <td class="nowrap">${formatDate(f.date)}</td>
      <td>
        <div class="route">${esc(f.from || '?')} → ${esc(f.to || '?')}</div>
        <div class="route-detail">${esc(city(f.from))} → ${esc(city(f.to))}${f.durationMin ? ' · ' + fmtDur(f.durationMin) : ''}</div>
      </td>
      <td>${esc(f.airline || '–')} ${f.flightNumber ? `<span style="color:var(--text3);font-size:11px">${esc(f.flightNumber)}</span>` : ''}</td>
      <td class="col-wide"><div style="font-size:13px">${esc(f.aircraftType || '–')}</div>${f.registration ? `<div style="font-size:11px;color:var(--text3)">${esc(f.registration)}</div>` : ''}</td>
      <td class="nowrap">${formatDist(f.distKm)}</td>
      <td class="co2-cell col-wide">${formatCO2(co2Of(f))}</td>
      ${multiClass ? `<td class="col-wide">${classBadge(f.cabinClass)}</td>` : ''}
    </tr>`).join('')}</tbody>
  </table>`;
}

function sortBy(key) {
  if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
  renderFlightsTable();
}

function updateYearFilter() {
  const sel = $('filter-year');
  const years = [...new Set(flights.map(f => f.date.slice(0, 4)).filter(Boolean))].sort().reverse();
  const cur = sel.value;
  sel.innerHTML = '<option value="">Toutes les années</option>' + years.map(y => `<option value="${esc(y)}" ${cur === y ? 'selected' : ''}>${esc(y)}</option>`).join('');
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

// The background map is drawn from country outlines shipped with the site (world.js).
// No map provider, no key, and it works offline.
let countryLayers = null;      // country code -> list of Leaflet polygons
let routeLayers = {}, markerLayers = {};
let fittedFor = '';            // airports the map was last framed on
let mapSelection = null;       // { type: 'airport', code } or { type: 'route', key }

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const routeKey = (a, b) => [a, b].sort().join('-');
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function decodeRings(rings) {
  return rings.map(r => {
    const pts = [];
    let x = 0, y = 0;
    for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; pts.push([y / 100, x / 100]); }
    return [pts];
  });
}

function initMap() {
  leafletMap = L.map('map', { center: [45, 10], zoom: 3, minZoom: 1, maxZoom: 8, zoomSnap: 0.25, worldCopyJump: false });
  leafletMap.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  leafletMap.attributionControl.addAttribution('Fond : <a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a>');

  countryLayers = {};
  if (typeof WORLD !== 'undefined') {
    const renderer = L.canvas({ padding: 0.5 });
    const style = { renderer, interactive: false, weight: 0.6, color: cssVar('--land-line'), fillColor: cssVar('--land'), fillOpacity: 1 };
    WORLD.countries.forEach(c => {
      const poly = L.polygon(decodeRings(c.r), style).addTo(leafletMap);
      if (c.c) (countryLayers[c.c] = countryLayers[c.c] || []).push(poly);
    });
  }

  // "Show all" button under the zoom buttons
  const Fit = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'leaflet-bar');
      const a = L.DomUtil.create('a', 'map-fit', box);
      a.href = '#'; a.title = 'Voir tous les vols'; a.setAttribute('aria-label', 'Voir tous les vols'); a.textContent = '⤢';
      L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); fitMap(true); });
      L.DomEvent.disableClickPropagation(box);
      return box;
    }
  });
  new Fit().addTo(leafletMap);
  leafletMap.on('click', closeMapPanel);
}

function usedAirports() {
  return [...new Set(flights.flatMap(f => [f.from, f.to]))].filter(c => AIRPORTS[c]);
}

function fitMap(force) {
  const codes = usedAirports();
  const key = codes.sort().join(',');
  if (!force && key === fittedFor) return;
  fittedFor = key;
  if (!codes.length) { leafletMap.setView([45, 10], 3); return; }
  if (codes.length === 1) { const a = AIRPORTS[codes[0]]; leafletMap.setView([a.lat, a.lon], 5); return; }
  const wide = window.innerWidth > 768 && !$('map-panel').hidden;
  leafletMap.fitBounds(L.latLngBounds(codes.map(c => [AIRPORTS[c].lat, AIRPORTS[c].lon])), {
    paddingTopLeft: [40, 40], paddingBottomRight: [wide ? 360 : 40, 40], maxZoom: 6
  });
}

function renderMap() {
  if (typeof L === 'undefined') { $('map').innerHTML = '<div class="empty-state"><p>La carte ne se charge pas. Vérifiez la connexion internet.</p></div>'; return; }
  if (!leafletMap) initMap();
  Object.values(routeLayers).forEach(l => l.remove());
  Object.values(markerLayers).forEach(l => l.remove());
  routeLayers = {}; markerLayers = {};

  // Visited countries
  const visited = new Set(flights.flatMap(f => [AIRPORTS[f.from]?.country, AIRPORTS[f.to]?.country]).filter(Boolean));
  for (const [cc, polys] of Object.entries(countryLayers)) {
    const v = visited.has(cc);
    polys.forEach(p => p.setStyle({ fillColor: cssVar(v ? '--visited' : '--land'), color: cssVar(v ? '--visited-line' : '--land-line') }));
  }

  // One line per pair of airports, both directions together
  const routes = {};
  flights.forEach(f => {
    if (!AIRPORTS[f.from] || !AIRPORTS[f.to]) return;
    const k = routeKey(f.from, f.to);
    (routes[k] = routes[k] || { a: f.from, b: f.to, n: 0 }).n++;
  });
  for (const [k, r] of Object.entries(routes)) {
    const A = AIRPORTS[r.a], B = AIRPORTS[r.b];
    const line = L.polyline(greatCirclePoints(A.lat, A.lon, B.lat, B.lon), {
      color: cssVar('--route'), weight: Math.min(1.5 + r.n * 0.5, 6), opacity: 0.75, lineCap: 'round'
    });
    line.bindTooltip(`${r.a} ↔ ${r.b} · ${plural(r.n, 'vol', 'vols')}`, { sticky: true, className: 'map-tip' });
    line.on('click', e => { L.DomEvent.stopPropagation(e); showRoutePanel(k); });
    line.addTo(leafletMap);
    routeLayers[k] = line;
  }

  // Airports, the busiest drawn last so they stay clickable on top
  const counts = {};
  flights.forEach(f => { counts[f.from] = (counts[f.from] || 0) + 1; counts[f.to] = (counts[f.to] || 0) + 1; });
  usedAirports().sort((a, b) => counts[a] - counts[b]).forEach(code => {
    const ap = AIRPORTS[code];
    const m = L.circleMarker([ap.lat, ap.lon], {
      radius: Math.min(5 + Math.sqrt(counts[code]) * 1.6, 15),
      fillColor: cssVar('--marker'), color: cssVar('--marker-line'), weight: 2, opacity: 1, fillOpacity: 1
    });
    m.bindTooltip(`<b>${esc(code)}</b> ${esc(ap.city)}`, { direction: 'top', offset: [0, -6], className: 'map-tip' });
    m.on('click', e => { L.DomEvent.stopPropagation(e); showAirportPanel(code); });
    m.addTo(leafletMap);
    markerLayers[code] = m;
  });

  setTimeout(() => {
    leafletMap.invalidateSize();
    fitMap(false);
    if (mapSelection) reopenMapPanel(); else applyHighlight();
  }, 60);
}

// Dims everything not linked to the selected airport or route
function applyHighlight() {
  const sel = mapSelection;
  for (const [k, line] of Object.entries(routeLayers)) {
    const on = !sel || (sel.type === 'airport' ? k.split('-').includes(sel.code) : k === sel.key);
    line.setStyle({ opacity: on ? (sel ? 1 : 0.75) : 0.12, color: cssVar(on && sel ? '--route-on' : '--route') });
    if (on && sel) line.bringToFront();
  }
  const linked = new Set();
  if (sel?.type === 'airport') {
    linked.add(sel.code);
    Object.keys(routeLayers).forEach(k => { const [a, b] = k.split('-'); if (a === sel.code) linked.add(b); if (b === sel.code) linked.add(a); });
  } else if (sel?.type === 'route') sel.key.split('-').forEach(c => linked.add(c));
  for (const [code, m] of Object.entries(markerLayers)) {
    const on = !sel || linked.has(code);
    const main = sel && (sel.type === 'airport' ? code === sel.code : linked.has(code));
    m.setStyle({ fillOpacity: on ? 1 : 0.25, opacity: on ? 1 : 0.25, fillColor: cssVar(main ? '--marker-on' : '--marker') });
    if (on) m.bringToFront();
  }
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
  if (s.type === 'airport' && markerLayers[s.code]) showAirportPanel(s.code);
  else if (s.type === 'route' && routeLayers[s.key]) showRoutePanel(s.key);
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

let journalObserver = null;

function renderJournal() {
  const el = $('journal');
  if (journalObserver) { journalObserver.disconnect(); journalObserver = null; }
  if (!flights.length) {
    el.innerHTML = '<div class="empty-state"><div class="emoji">📔</div><p>Aucun vol pour l\'instant.</p><button class="btn btn-primary" onclick="openModal()">+ Ajouter le premier vol</button></div>';
    return;
  }
  const trips = buildTrips().reverse();   // most recent trip first; flights inside a trip stay in order
  const byYear = {};
  trips.forEach(t => { (byYear[t.start.slice(0, 4)] = byYear[t.start.slice(0, 4)] || []).push(t); });

  el.innerHTML = Object.keys(byYear).sort().reverse().map(year => {
    const list = byYear[year];
    const n = list.reduce((s, t) => s + t.flights.length, 0);
    const km = list.reduce((s, t) => s + t.km, 0);
    return `<div class="j-year"><h2>${esc(year)}</h2><span>${plural(list.length, 'voyage', 'voyages')} · ${plural(n, 'vol', 'vols')} · ${fmtInt(km)} km</span></div>
      ${list.map(t => {
        const days = daysBetween(t.start, t.end) + 1;
        const dates = t.start === t.end ? formatDate(t.start) : `du ${formatDate(t.start)} au ${formatDate(t.end)} · ${days} jours`;
        return `<article class="j-trip">
          <div class="j-trip-head">
            <div class="j-trip-title"><span class="j-trip-flags">${t.countries.map(countryFlag).join(' ')}</span>${esc(t.places.join(' · '))}</div>
            <div class="j-trip-sub">${dates}${t.via.length ? ` · via ${esc(t.via.join(', '))}` : ''}${t.people.length ? `<br>avec ${esc(t.people.join(', '))}` : ''}</div>
          </div>
          <ol class="j-flights">${t.flights.map(f => {
            const meta = [[f.airline, f.flightNumber].filter(Boolean).join(' '), f.aircraftType, f.seat ? 'siège ' + f.seat : '', fmtDur(f.durationMin)].filter(Boolean);
            return `<li class="j-flight" data-flight="${esc(f.id)}" tabindex="0" role="button" aria-label="Voir le vol ${esc(f.from)} vers ${esc(f.to)} du ${formatDate(f.date)}">
              <div class="j-line">
                <span class="j-date">${formatDate(f.date)}</span>
                <span class="j-route">${esc(f.from)} → ${esc(f.to)}</span>
                <span class="j-cities">${esc(city(f.from))} → ${esc(city(f.to))}</span>
              </div>
              <div class="j-meta">${esc(meta.join(' · '))}</div>
              ${f.notes ? `<p class="j-notes">${esc(f.notes)}</p>` : ''}
              ${f.photo ? `<div class="j-photo" data-photo="${esc(f.photo)}"></div>` : ''}
            </li>`;
          }).join('')}</ol>
        </article>`;
      }).join('')}`;
  }).join('');

  // Photos are downloaded only when they come into view
  const load = box => {
    photoURL(box.dataset.photo).then(url => {
      const img = new Image();
      img.alt = 'Photo du vol'; img.loading = 'lazy'; img.src = url;
      box.replaceChildren(img);
    }).catch(() => { box.innerHTML = '<div class="j-empty-photo">Photo indisponible</div>'; });
  };
  const boxes = el.querySelectorAll('.j-photo');
  if ('IntersectionObserver' in window) {
    journalObserver = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { journalObserver.unobserve(e.target); load(e.target); }
    }), { rootMargin: '400px' });
    boxes.forEach(b => journalObserver.observe(b));
  } else boxes.forEach(load);
}

// ═══════════════════════════════════════
//  ANALYTICS
// ═══════════════════════════════════════
function renderAnalytics() {
  charts.forEach(c => c.destroy());
  charts = [];
  const container = $('charts-container');
  if (!flights.length) {
    container.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="emoji">📊</div><p>Ajoutez des vols pour voir les statistiques.</p></div>';
    return;
  }

  const byYear = {}, distByYear = {}, byAirline = {}, byAirport = {}, byRoute = {}, byAircraft = {};
  flights.forEach(f => {
    const y = f.date.slice(0, 4);
    if (y) { byYear[y] = (byYear[y] || 0) + 1; distByYear[y] = (distByYear[y] || 0) + (f.distKm || 0); }
    if (f.airline) byAirline[f.airline] = (byAirline[f.airline] || 0) + 1;
    if (f.from) byAirport[f.from] = (byAirport[f.from] || 0) + 1;
    if (f.to) byAirport[f.to] = (byAirport[f.to] || 0) + 1;
    if (f.from && f.to) { const k = [f.from, f.to].sort().join('↔'); byRoute[k] = (byRoute[k] || 0) + 1; }
    const ac = f.aircraftType || f.registration;
    if (ac) byAircraft[ac] = (byAircraft[ac] || 0) + 1;
  });
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const years = Object.keys(byYear).sort();
  const topAirlines = top(byAirline, 8), topAirports = top(byAirport, 8), topAircraft = top(byAircraft, 8), topRoutes = top(byRoute, 10);

  container.innerHTML = `
    <div class="chart-card"><div class="chart-title">✈️ Vols par année</div><canvas id="chart-year"></canvas></div>
    <div class="chart-card"><div class="chart-title">📐 Distance par année (km)</div><canvas id="chart-dist"></canvas></div>
    <div class="chart-card"><div class="chart-title">🏢 Aéroports les plus fréquentés</div><ul class="top-list" id="top-airports"></ul></div>
    <div class="chart-card"><div class="chart-title">🛤️ Trajets les plus fréquents</div><ul class="top-list" id="top-routes"></ul></div>
    ${topAirlines.length ? '<div class="chart-card" style="grid-column:1/-1"><div class="chart-title">🛫 Compagnies</div><ul class="top-list" id="top-airlines"></ul></div>' : ''}
    ${topAircraft.length ? '<div class="chart-card" style="grid-column:1/-1"><div class="chart-title">🛩 Types d\'avion</div><ul class="top-list" id="top-aircraft"></ul></div>' : ''}
    <div class="chart-card" style="grid-column:1/-1"><div class="chart-title">💺 Sièges occupés</div><div id="seat-heatmap"></div></div>`;

  if (typeof Chart !== 'undefined') {
    const opts = {
      responsive: true, plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: '#1e2d47' } },
        y: { ticks: { color: '#94a3b8', precision: 0 }, grid: { color: '#1e2d47' }, beginAtZero: true }
      }
    };
    charts.push(new Chart($('chart-year'), { type: 'bar', data: { labels: years, datasets: [{ label: 'Vols', data: years.map(y => byYear[y]), backgroundColor: '#3b82f6', borderRadius: 6 }] }, options: opts }));
    charts.push(new Chart($('chart-dist'), { type: 'bar', data: { labels: years, datasets: [{ label: 'km', data: years.map(y => distByYear[y] || 0), backgroundColor: '#10b981', borderRadius: 6 }] }, options: opts }));
  }

  const bar = (n, max, color) => `<div class="bar-wrap"><div class="bar" style="width:${(n / max * 100).toFixed(0)}%;background:${color}"></div></div>`;
  $('top-airports').innerHTML = topAirports.map(([c, n], i) => `<li>
      <span class="rank">${i + 1}</span>
      <span style="font-weight:600;color:var(--accent2)">${esc(c)}</span>
      <span style="color:var(--text3);font-size:11px">${esc(AIRPORTS[c]?.city || '')}</span>
      ${bar(n, topAirports[0][1], 'var(--accent)')}<span class="count">${n}</span>
    </li>`).join('');
  $('top-routes').innerHTML = topRoutes.map(([key, n], i) => {
    const [a, b] = key.split('↔');
    return `<li>
      <span class="rank">${i + 1}</span>
      <span style="font-weight:600;color:var(--accent2);white-space:nowrap">${esc(a)} ↔ ${esc(b)}</span>
      <span style="color:var(--text3);font-size:11px">${esc(city(a))} · ${esc(city(b))}</span>
      ${bar(n, topRoutes[0][1], 'var(--yellow)')}<span class="count">${n}×</span>
    </li>`;
  }).join('');
  const simple = (id, data, color) => {
    if ($(id)) $(id).innerHTML = data.map(([name, n], i) => `<li>
      <span class="rank">${i + 1}</span><span style="flex:1">${esc(name)}</span>
      ${bar(n, data[0][1], color)}<span class="count">${n}</span>
    </li>`).join('');
  };
  simple('top-airlines', topAirlines, 'var(--green)');
  simple('top-aircraft', topAircraft, 'var(--purple)');
  renderSeatHeatmap();
}

function renderSeatHeatmap() {
  const el = $('seat-heatmap');
  const seats = {};
  flights.forEach(f => {
    const m = (f.seat || '').trim().toUpperCase().match(/^(\d+)([A-K])$/);
    if (m) { const k = `${parseInt(m[1])}-${m[2]}`; seats[k] = (seats[k] || 0) + 1; }
  });
  const keys = Object.keys(seats);
  if (!keys.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:13px;padding:8px 0">Aucun siège enregistré. Ajoutez le numéro de siège (ex. 14A) dans vos vols.</p>';
    return;
  }
  const rows = keys.map(k => parseInt(k.split('-')[0]));
  const cols = [...new Set(keys.map(k => k.split('-')[1]))].sort();
  const minRow = Math.min(...rows), maxRow = Math.max(...rows), maxCnt = Math.max(...Object.values(seats));
  const isWide = cols.some(c => 'GHJK'.includes(c));
  const aisleAfter = isWide ? new Set(['C', 'G']) : new Set(['C']);
  const rgb = t => `rgb(${Math.round(29 + t * 216)},${Math.round(78 + t * 80)},${Math.round(216 - t * 205)})`;
  const third = Math.floor((maxRow - minRow + 1) / 3);

  let html = `<div style="overflow-x:auto;padding-bottom:6px"><table style="width:auto;border-collapse:separate;border-spacing:2px;margin:0 auto;font-size:11px">
    <thead><tr><td style="padding:0 8px 6px 0;border:none;color:var(--text3);font-size:10px;text-align:right">Rang</td>`;
  for (const c of cols) {
    html += `<td style="border:none;text-align:center;font-weight:700;color:var(--text3);padding:0 1px 6px;min-width:26px">${c}</td>`;
    if (aisleAfter.has(c)) html += '<td style="border:none;min-width:10px;padding:0"></td>';
  }
  html += '<td style="border:none;padding:0"></td></tr></thead><tbody>';
  for (let row = minRow; row <= maxRow; row++) {
    const label = row === minRow ? '← avant' : row === minRow + third ? '← milieu' : row === maxRow - third + 1 ? '← arrière' : '';
    html += `<tr><td style="border:none;text-align:right;padding:0 8px 0 0;color:var(--text3);font-size:10px;line-height:20px">${row}</td>`;
    for (const c of cols) {
      const n = seats[`${row}-${c}`] || 0;
      html += `<td title="${row}${c}${n ? ` : ${n} vol${n > 1 ? 's' : ''}` : ''}" style="border:none;padding:0;width:26px;height:20px;background:${n ? rgb(n / maxCnt) : 'rgba(15,23,42,0.8)'};border-radius:3px;text-align:center;font-size:10px;font-weight:700;color:rgba(255,255,255,.9)">${n || ''}</td>`;
      if (aisleAfter.has(c)) html += '<td style="border:none;padding:0;width:10px"></td>';
    }
    html += `<td style="border:none;padding:0 0 0 10px;color:var(--text3);font-size:10px;white-space:nowrap;font-style:italic">${label}</td></tr>`;
  }
  html += `</tbody></table></div>
    <div style="display:flex;align-items:center;gap:6px;margin-top:14px;justify-content:center;flex-wrap:wrap;font-size:11px;color:var(--text3)">
      <div style="width:26px;height:14px;background:rgba(15,23,42,0.8);border-radius:2px;border:1px solid var(--border)"></div><span>0×</span>
      ${[0, 0.25, 0.5, 0.75, 1].map(t => `<div style="width:26px;height:14px;background:${rgb(t)};border-radius:2px"></div>`).join('')}
      <span>${maxCnt}×</span>
      <span style="margin-left:10px;font-style:italic">${keys.length} siège${keys.length > 1 ? 's' : ''} différent${keys.length > 1 ? 's' : ''} · ${isWide ? 'avion à deux couloirs' : 'avion à un couloir'}</span>
    </div>`;
  el.innerHTML = html;
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
