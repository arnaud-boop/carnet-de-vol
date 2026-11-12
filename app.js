'use strict';
// SkyLog · Carnet de vol
// The page holds no flight data. Flights live in a private GitHub repository:
//   flights.json          Liv's logbook: the flights and the airports they use
//   arnaud.json           Arnaud's logbook: same format, plus his history as routes
//   photos/<name>.jpg     one image file per flight photo
// Each save is one commit, so GitHub keeps the full history.

// ═══════════════════════════════════════
//  STATE
// ═══════════════════════════════════════
const CFG_KEY = 'carnet_config';     // { owner, repo, branch, token } for this device
const CARNET_KEY = 'carnet_current'; // logbook last opened on this device
const GH_API = 'https://api.github.com';

// Two logbooks in the same repository. "inOther" is how this person is named
// in the companions of the other logbook (used when a flight is copied there).
const CARNETS = {
  liv: { label: 'Liv', of: 'de Liv', file: 'flights.json', cache: 'carnet_cache', inOther: 'Liv' },
  arnaud: { label: 'Arnaud', of: 'd\'Arnaud', file: 'arnaud.json', cache: 'carnet_cache_arnaud', inOther: 'Papa' }
};
let carnet = 'liv';
const dataFile = () => CARNETS[carnet].file;
const otherCarnet = () => (carnet === 'liv' ? 'arnaud' : 'liv');

let cfg = null;
let flights = [];
let routes = [];                      // history without dates: { from, to, count, distKm, ab, abEst, airline, airlineEst } (Arnaud)
                                      // ab: flights from -> to (the others go to -> from); abEst: that split is an estimate
                                      // airline: deduced from the airlines per airport; airlineEst: only probable
let airlinesList = [];                // airlines of the history, without counts
let airportAirlines = {};             // history: airport code -> airlines taken there
let historyUntil = '';                // last day covered by the history (YYYY-MM-DD)
let countryStatus = {};               // passport: country code -> 'visited' | 'stopover' | 'land'
let dataSha = null;                  // version of the data file this device last saw
let saving = false;
const hasHistory = () => routes.length > 0;

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

// Codes are IATA (3 letters). A field without one keeps its ICAO code (4 letters, e.g. LFPX).
function addAirports(map) {
  if (!map || typeof map !== 'object') return;
  for (const [code, a] of Object.entries(map)) {
    if (!/^[A-Z0-9]{3,4}$/.test(code) || !a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
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
  const obj = Array.isArray(doc) ? {} : doc;
  routes = (Array.isArray(obj.routes) ? obj.routes : []).map(r => {
    const x = {
      from: String(r?.from || '').toUpperCase(), to: String(r?.to || '').toUpperCase(),
      count: Math.max(0, Math.round(+r?.count || 0)), distKm: Math.max(0, Math.round(+r?.distKm || 0))
    };
    if (Number.isInteger(r?.ab) && r.ab >= 0 && r.ab <= x.count) { x.ab = r.ab; if (r.abEst) x.abEst = true; }
    const al = String(r?.airline || '').trim();
    if (al) { x.airline = al; if (r.airlineEst) x.airlineEst = true; }
    return x;
  }).filter(r => /^[A-Z0-9]{3,4}$/.test(r.from) && /^[A-Z0-9]{3,4}$/.test(r.to) && r.count > 0);
  airlinesList = (Array.isArray(obj.airlines) ? obj.airlines : []).map(s => String(s || '').trim()).filter(Boolean);
  airportAirlines = {};
  const aa = obj.airportAirlines;
  if (aa && typeof aa === 'object') {
    for (const [c, list] of Object.entries(aa)) {
      const names = Array.isArray(list) ? list.map(s => String(s || '').trim()).filter(Boolean) : [];
      if (/^[A-Z0-9]{3,4}$/.test(c) && names.length) airportAirlines[c] = names;
    }
  }
  historyUntil = /^\d{4}-\d{2}-\d{2}$/.test(obj.historyUntil || '') ? obj.historyUntil : '';
  countryStatus = {};
  const cs = obj.countryStatus;
  if (cs && typeof cs === 'object') {
    for (const [cc, st] of Object.entries(cs)) if (/^[A-Z]{2}$/.test(cc) && ['visited', 'stopover', 'land'].includes(st)) countryStatus[cc] = st;
  }
}

// The file content: flights sorted by date, plus every airport they use.
// Airports are saved with the flights so the map, the countries and the
// durations never depend on a download. The history (routes) is kept as it is.
function buildDoc() {
  const sorted = [...flights].sort((a, b) => (a.date + a.departureTime).localeCompare(b.date + b.departureTime));
  const airports = {};
  [...new Set([...sorted, ...routes].flatMap(f => [f.from, f.to]).filter(Boolean))].sort().forEach(c => {
    const a = AIRPORTS[c];
    if (a) airports[c] = { name: a.name, city: a.city, country: a.country, lat: a.lat, lon: a.lon, tz: a.tz || null };
  });
  const doc = { schema: 1, airports, flights: sorted };
  if (routes.length) {
    doc.routes = routes;
    if (airlinesList.length) doc.airlines = airlinesList;
    if (Object.keys(airportAirlines).length) doc.airportAirlines = airportAirlines;
    if (historyUntil) doc.historyUntil = historyUntil;
  }
  const cs = Object.keys(countryStatus).sort();
  if (cs.length) doc.countryStatus = Object.fromEntries(cs.map(cc => [cc, countryStatus[cc]]));
  return doc;
}

// Every pair of airports flown, both directions together: { key: { a, b, n, km } }.
// km is the distance of one flight. The history counts when withHistory is true.
// ab / ba: flights from a to b / from b to a; unk: flights whose direction is not known; est: the split is an estimate.
function legMap(list, withHistory) {
  const m = {};
  const add = (a, b, n, km, nab, est) => {   // nab: flights from a to b among the n
    if (!a || !b) return;
    if (a === b) nab = n;   // local flights: they leave and come back
    const k = routeKey(a, b);
    const x = m[k] = m[k] || { key: k, a: k.split('-')[0], b: k.split('-')[1], n: 0, km: 0, flights: 0, ab: 0, ba: 0, unk: 0, est: false, al: {} };
    x.n += n;
    if (nab == null) x.unk += n;
    else if (a === x.a) { x.ab += nab; x.ba += n - nab; } else { x.ba += nab; x.ab += n - nab; }
    if (est) x.est = true;
    if (km && !x.km) x.km = km;
  };
  // al: airline -> { n, est } (est: deduced from the history and only probable)
  const addAl = (x, name, n, est) => { const y = x.al[name] = x.al[name] || { n: 0, est: false }; y.n += n; if (est) y.est = true; };
  if (withHistory) routes.forEach(r => {
    add(r.from, r.to, r.count, r.distKm, r.ab ?? null, r.abEst);
    if (r.airline) addAl(m[routeKey(r.from, r.to)], r.airline, r.count, r.airlineEst);
  });
  list.forEach(f => {
    add(f.from, f.to, 1, f.distKm || getDistance(f.from, f.to), 1);
    const x = m[routeKey(f.from, f.to)];
    if (x) x.flights++;   // detailed flights on this route
    if (x && f.airline) addAl(x, f.airline, 1, false);
  });
  return m;
}
const allLegs = () => Object.values(legMap(flights, true));
// Direction of a pair of airports: 'ab' or 'ba' when every flight went the same way, '' otherwise
const legDir = l => l.a === l.b || l.unk ? '' : !l.ba ? 'ab' : !l.ab ? 'ba' : '';
// Flight time (take-off to landing, in minutes) estimated from the distance. Calibrated on Liv's 60 flights timed
// on Flightradar24: cruise at 820 km/h, plus up to 17.5 min for the climb and the descent (less on very short flights).
const estFlightMin = km => km > 0 ? km / 820 * 60 + 17.5 * (1 - Math.exp(-km / 150)) : 0;
const EST_RULE = 'distance ÷ 820 km/h, plus jusqu\'à 17 min 30 pour la montée et la descente (moins sur les vols très courts)';

// Totals of the whole logbook. Hours: the real duration when known, else estimated from the distance (history only).
function logTotals() {
  const legs = allLegs();
  const n = legs.reduce((s, l) => s + l.n, 0);
  const km = routes.reduce((s, r) => s + r.count * r.distKm, 0) + flights.reduce((s, f) => s + (f.distKm || 0), 0);
  const estMin = routes.reduce((s, r) => s + r.count * estFlightMin(r.distKm), 0)
    + flights.reduce((s, f) => s + (f.durationMin || (hasHistory() ? estFlightMin(f.distKm || 0) : 0)), 0);
  const co2 = routes.reduce((s, r) => s + r.count * calcCO2(r.distKm, 'economy'), 0) + flights.reduce((s, f) => s + co2Of(f), 0);
  return { legs, n, km, mins: estMin, co2 };
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

// Reads one data file. Returns { doc, sha }, or { doc: null, sha: null } when the file does not exist yet.
async function readDataFile(file) {
  let r;
  try { r = await ghFetch(ghUrl(file) + refQuery()); }
  catch (e) {
    if (e.status !== 404) throw e;
    // No data file yet: check that the repository itself answers
    await ghFetch(`${GH_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`);
    return { doc: null, sha: null };
  }
  const j = await r.json();
  const text = (j.content && j.encoding === 'base64')
    ? b64ToUtf8(j.content)
    : await (await ghFetch(ghUrl(file) + refQuery(), {}, true)).text();   // files over 1 MB
  try { return { doc: JSON.parse(text), sha: j.sha }; }
  catch (e) { throw new StoreError('Le fichier de données est illisible.', -1); }
}

async function loadRemote() {
  const which = carnet;
  const { doc, sha } = await readDataFile(CARNETS[which].file);
  if (which !== carnet) return;   // the other logbook was opened meanwhile
  if (doc) applyDoc(doc);
  else applyDoc({ flights: [] });
  dataSha = sha;
  writeCache();
}

async function putFile(path, b64, message, sha) {
  const body = { message, content: b64, branch: cfg.branch };
  if (sha) body.sha = sha;
  const r = await ghFetch(ghUrl(path), { method: 'PUT', body: JSON.stringify(body) });
  return (await r.json()).content.sha;
}

function persist(message) {
  const which = carnet, body = utf8ToB64(JSON.stringify(buildDoc(), null, 2) + '\n');
  return queue(async () => {
    if (which !== carnet) throw new StoreError('Le carnet a changé pendant l\'enregistrement.', -1);
    dataSha = await putFile(CARNETS[which].file, body, `${CARNETS[which].label} : ${message}`, dataSha);
    writeCache();
  });
}

// Adds a copy of a flight to the other logbook (a flight taken together).
// The seat and the photo stay in this logbook only; companions are swapped.
function copyToOtherCarnet(f) {
  const to = otherCarnet(), from = carnet;
  const people = (f.coTravelers || '').split(',').map(p => p.trim()).filter(p => p && norm(p) !== norm(CARNETS[to].inOther));
  if (!people.some(p => norm(p) === norm(CARNETS[from].inOther))) people.unshift(CARNETS[from].inOther);
  const copy = { ...f, id: uid(), seat: '', photo: null, coTravelers: people.join(', ') };
  return queue(async () => {
    const { doc, sha } = await readDataFile(CARNETS[to].file);
    const d = doc && !Array.isArray(doc) ? doc : { schema: 1, airports: {}, flights: Array.isArray(doc) ? doc : [] };
    d.flights = Array.isArray(d.flights) ? d.flights : [];
    if (d.flights.some(x => x.date === f.date && x.from === f.from && x.to === f.to)) return 'exists';
    d.flights.push(copy);
    d.flights.sort((a, b) => ((a.date || '') + (a.departureTime || '')).localeCompare((b.date || '') + (b.departureTime || '')));
    d.airports = d.airports && typeof d.airports === 'object' ? d.airports : {};
    [f.from, f.to].forEach(c => {
      const a = AIRPORTS[c];
      if (a && !d.airports[c]) d.airports[c] = { name: a.name, city: a.city, country: a.country, lat: a.lat, lon: a.lon, tz: a.tz || null };
    });
    await putFile(CARNETS[to].file, utf8ToB64(JSON.stringify(d, null, 2) + '\n'), `${CARNETS[to].label} : ajout du vol ${f.from}-${f.to} du ${formatDate(f.date)} (copié du carnet ${CARNETS[from].of})`, sha);
    try { localStorage.removeItem(CARNETS[to].cache); } catch (e) {}
    return 'added';
  });
}

// Applies a change in memory, then saves it. If the save fails the change is undone.
async function commitChange(mutate, message) {
  const before = flights.slice(), beforeCountries = { ...countryStatus }, which = carnet;
  mutate();
  setStatus('busy', 'Enregistrement…');
  try {
    await persist(message);
    setStatus('ok');
    return true;
  } catch (e) {
    if (which !== carnet) { showToast('Non enregistré : le carnet a changé pendant l\'enregistrement.', true); return false; }
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
  try { localStorage.setItem(CARNETS[carnet].cache, JSON.stringify({ doc: buildDoc(), sha: dataSha, at: Date.now() })); } catch (e) {}
}
function readCache() {
  try { return JSON.parse(localStorage.getItem(CARNETS[carnet].cache) || 'null'); } catch (e) { return null; }
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
  $('app').hidden = true; $('header-actions').hidden = true; $('banner').hidden = true; $('nav').hidden = true; $('who').hidden = true;
  $('setup').hidden = false;
  $('setup-error').textContent = message || '';
  if (!$('cfg-repo').value) {
    const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
    if (m) $('cfg-repo').value = `${m[1]}/carnet-de-vol-data`;
  }
}
function showApp() {
  $('setup').hidden = true; $('app').hidden = false; $('header-actions').hidden = false; $('nav').hidden = false; $('who').hidden = false;
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
    showToast('Appareil connecté.');
    if (!storedCarnet()) openWhoModal();
  } catch (err) {
    cfg = null;
    $('setup-error').textContent = err.message || 'Connexion impossible.';
  } finally {
    btn.disabled = false; btn.textContent = 'Connecter';
  }
}

function disconnect() {
  if (!confirm('Supprimer la clé d\'accès et la copie locale de cet appareil ?\n\nLes vols restent enregistrés sur GitHub.')) return;
  try {
    localStorage.removeItem(CFG_KEY); localStorage.removeItem(CARNET_KEY);
    Object.values(CARNETS).forEach(c => localStorage.removeItem(c.cache));
  } catch (e) {}
  cfg = null; flights = []; routes = []; dataSha = null;
  photoCache.forEach(u => { if (u.startsWith('blob:')) URL.revokeObjectURL(u); });
  photoCache.clear();
  showSetup();
}

// ─── Which logbook: Liv or Arnaud. Each device remembers the last one; #liv or #arnaud in the address wins. ───
function storedCarnet() {
  try { const v = localStorage.getItem(CARNET_KEY); return CARNETS[v] ? v : null; } catch (e) { return null; }
}
function hashCarnet() {
  const h = location.hash.slice(1).toLowerCase();
  return CARNETS[h] ? h : null;
}
function updateCarnetUI() {
  document.querySelectorAll('[data-carnet]').forEach(b => {
    const on = b.dataset.carnet === carnet;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const tab = document.querySelector('.nav-tab[data-view="flights"]');
  tab.querySelector('.lg').textContent = hasHistory() ? 'Trajets' : 'Mes vols';
  tab.querySelector('.sh').textContent = hasHistory() ? 'Trajets' : 'Vols';
  document.title = `Carnet de vol · ${CARNETS[carnet].label}`;
}
function openWhoModal() { $('who-modal').classList.add('open'); }

async function switchCarnet(name) {
  if (!CARNETS[name]) return;
  closeModal('who-modal');
  try { localStorage.setItem(CARNET_KEY, name); } catch (e) {}
  try { history.replaceState(null, '', location.pathname + location.search + '#' + name); } catch (e) {}
  if (name === carnet) { updateCarnetUI(); return; }
  carnet = name;
  flights = []; routes = []; airlinesList = []; airportAirlines = {}; historyUntil = ''; countryStatus = {}; dataSha = null;
  mapYear = ''; journalYear = ''; fittedFor = '';
  closeMapPanel();
  $('search-input').value = ''; $('filter-year').value = ''; $('filter-class').value = '';
  const cached = readCache();
  if (cached?.doc) { try { applyDoc(cached.doc); dataSha = cached.sha || null; } catch (e) {} }
  renderAll();
  window.scrollTo(0, 0);
  await reloadData(true);
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
  // A new tab starts at the top of the page, not at the scroll position of the previous tab
  if (!$('view-' + name)?.classList.contains('active')) window.scrollTo(0, 0);
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  renderAll();
}
function renderAll() {
  updateCarnetUI();
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
  const auto = {};   // cc -> { stay: bool, first, trips:Set, n }
  const touch = (cc, date, tripIdx, isStay, n = 1) => {
    if (!cc) return;
    const c = auto[cc] = auto[cc] || { stay: false, first: date, trips: new Set(), n: 0 };
    if (date < c.first) c.first = date;
    c.n += n;
    if (isStay) { c.stay = true; if (tripIdx >= 0) c.trips.add(tripIdx); }
  };
  const home = homeAirport();
  if (home && AIRPORTS[home]) touch(AIRPORTS[home].country, hasHistory() ? '' : flights.reduce((m, f) => f.date < m ? f.date : m, '9999'), -1, true, 0);
  // The history has no dates: every country it reaches counts as visited ('' = before the detailed flights)
  routes.forEach(r => [r.from, r.to].forEach(c => touch(AIRPORTS[c]?.country, '', -1, true, r.count)));
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
    const row = { cc, first: c.first, trips: c.trips.size, n: c.n, status, auto: autoStatus, overridden: status !== autoStatus };
    (status === 'stopover' ? stopover : visited).push(row);
  }
  for (const [cc, st] of Object.entries(countryStatus)) {
    if (st === 'land' && !auto[cc]) visited.push({ cc, first: '', trips: 0, n: 0, status: 'land', auto: null, overridden: true });
  }
  // Order: history (most flights first), then by first visit; countries without flights last
  const sortKey = r => r.status === 'land' ? 'z' : r.first ? 'b' + r.first : 'a';
  const order = (a, b) => sortKey(a).localeCompare(sortKey(b)) || (b.n - a.n) || a.cc.localeCompare(b.cc);
  visited.sort(order);
  stopover.sort(order);
  return { visited, stopover, trips };
}

function homeAirport() {
  const counts = {};
  allLegs().forEach(l => [l.a, l.b].forEach(c => { counts[c] = (counts[c] || 0) + l.n; }));
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
}
// Passages per airport (departures and arrivals together), history included
function airportPassages() {
  const counts = {};
  allLegs().forEach(l => {
    counts[l.a] = (counts[l.a] || 0) + l.n;
    if (l.b !== l.a) counts[l.b] = (counts[l.b] || 0) + l.n;
  });
  return counts;
}

const STAMP_COLORS = ['#B23A2E', '#1E7864', '#2E6DAE', '#7A4FB0', '#B5651D', '#A33A6B', '#3E7D2A', '#9A6A12', '#2B6E8F', '#8C2A37'];
function stampHTML(row, i) {
  const cls = row.status === 'land' ? 'land' : row.status === 'stopover' ? 'stop' : '';
  const color = row.status === 'stopover' ? '' : `color:${STAMP_COLORS[i % STAMP_COLORS.length]};`;
  const rot = ((row.cc.charCodeAt(0) * 7 + row.cc.charCodeAt(1) * 3) % 15) - 7;
  const sub = row.status === 'land' ? 'sans avion'
    : row.status === 'stopover' ? 'escale'
    : row.first ? `${row.first.slice(0, 4)}${row.trips > 1 ? ' · ' + row.trips + '×' : ''}`
    : plural(row.n, 'vol', 'vols');
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
function usedAirportsAll() { return [...new Set([...flights, ...routes].flatMap(f => [f.from, f.to]))].filter(c => AIRPORTS[c]); }

// Departure board: each value written in split-flap tiles
function flapTiles(text) {
  return `<span class="tiles">${[...String(text).toUpperCase()].map(ch => ch === ' ' ? '<i class="gap"></i>' : `<i>${esc(ch)}</i>`).join('')}</span>`;
}
function shortType(t) { return String(t || '').replace(/^(Boeing|Airbus|Embraer|Bombardier|De Havilland|ATR)\s+/i, '').trim(); }

function renderPassport() {
  const el = $('passport');
  if (!flights.length && !hasHistory()) {
    el.innerHTML = '<div class="empty-state"><div class="emoji">🛂</div><p>Le passeport se remplit avec les vols.</p><button class="btn btn-primary" onclick="openModal()">+ Ajouter le premier vol</button></div>';
    return;
  }
  const H = hasHistory();
  const info = countryInfo();
  const T = logTotals();
  const km = T.km;
  const mins = H ? T.mins : flights.reduce((s, f) => s + (f.durationMin || 0), 0);
  const airports = usedAirportsAll().length;
  const first = flights.reduce((m, f) => f.date < m ? f.date : m, '9999');
  const last = flights.reduce((m, f) => f.date > m ? f.date : m, '0000');
  const hours = Math.floor(mins / 60);
  const nCountries = info.visited.length;
  const totalCO2 = T.co2;
  const home = homeAirport();
  const label = CARNETS[carnet].label;
  if (H) { renderPassportHistory(el, { info, T, hours, airports, nCountries, home, first, last, label }); return; }
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
        <div><div class="cover-kicker">Carnet de vol ${esc(CARNETS[carnet].of)} · ${esc(home || '')}</div><h1>Passeport<br>de voyage</h1></div>
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
      <div class="mrz" aria-hidden="true">${esc(pad(`P<NOR<<${label.toUpperCase()}<<CARNET<DE<VOL`))}<br>${esc(pad(`${flights.length}FLT<${Math.round(km)}KM<${nCountries}PAYS<${first.slice(0, 4)}`))}</div>
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

// Passport of a logbook with a history (Arnaud): the history has routes and counts, no dates.
// Hours are estimated from the distance (see estFlightMin).
function renderPassportHistory(el, { info, T, hours, airports, nCountries, home, last, label }) {
  const km = T.km;
  const legs = T.legs.filter(l => l.a !== l.b);   // loops (local flights) have no route on the map
  const longest = [...legs].sort((a, b) => b.km - a.km)[0];
  const frequent = [...legs].sort((a, b) => b.n - a.n || b.km - a.km)[0];
  const passages = airportPassages();
  const airlines = new Set([...airlinesList, ...flights.map(f => f.airline).filter(Boolean)]);
  const pad = s => (s + '<'.repeat(44)).slice(0, 44);
  const flags = info.visited.map(r => countryFlag(r.cc)).join(' ');
  const row = (lbl, value, sub, onclick) => `<button type="button" class="board-row" onclick="${onclick}">
      <span class="board-label">${lbl}</span>${flapTiles(value)}<span class="board-sub">${sub}</span></button>`;

  el.innerHTML = `
    <div class="cover">
      <div class="cover-top">
        <div><div class="cover-kicker">Carnet de vol ${esc(CARNETS[carnet].of)} · ${esc(home || '')}</div><h1>Passeport<br>de voyage</h1></div>
        <div class="emblem" aria-hidden="true">✈</div>
      </div>
      <div class="cover-map">${miniWorldSVG(info)}</div>
      <div class="cover-flags" title="Pays visités">${flags}</div>
      <div class="kpis">
        <button class="kpi" onclick="showView('flights')"><b>${fmtInt(T.n)}</b><span>vols</span></button>
        <button class="kpi" onclick="showDistancePopup()"><b>${fmtInt(km)}</b><span>km · ${(km / 40075).toFixed(1)}× la Terre</span></button>
        <button class="kpi" onclick="showDurationPopup()"><b>${fmtInt(hours)} h</b><span>dans les airs (estimé)</span></button>
        <button class="kpi" onclick="document.getElementById('stamps').scrollIntoView({behavior:'smooth',block:'start'})"><b>${nCountries}</b><span>pays visités</span></button>
        <button class="kpi" onclick="showAirportsPopup()"><b>${airports}</b><span>aéroports</span></button>
        <button class="kpi" onclick="showView('flights')"><b>${T.legs.length}</b><span>trajets différents</span></button>
      </div>
      <div class="cover-fields">
        <div><span>Historique</span><b>${historyUntil ? 'jusqu\'au ' + formatDate(historyUntil) : '–'}</b></div>
        <div><span>Dernier vol saisi</span><b>${flights.length ? formatDate(last) : 'à venir'}</b></div>
        <div><span>Aéroport d'attache</span><b>${esc(home || '–')} · ${esc(city(home))}</b></div>
      </div>
      <div class="mrz" aria-hidden="true">${esc(pad(`P<<<<<${label.toUpperCase()}<<CARNET<DE<VOL`))}<br>${esc(pad(`${T.n}FLT<${Math.round(km)}KM<${nCountries}PAYS<${T.legs.length}TRJ`))}</div>
    </div>

    <h2 class="sec-title" id="stamps">Tampons</h2>
    <div class="legend">
      <span><i class="dot"></i>visité en avion</span>
      <span><i class="dot d"></i>visité sans avion</span>
      <span><i class="dot g"></i>escale seulement</span>
      <span class="muted">L'historique n'a pas de dates : chaque pays compte comme visité. Un clic sur un tampon change son statut.</span>
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
      ${row('Heures en vol', fmtInt(hours), `estimées d'après la distance, soit ${(mins2days(T.mins))} jours`, 'showDurationPopup()')}
      ${longest ? row('Trajet le plus long', `${longest.a}-${longest.b}`, `${fmtInt(longest.km)} km · ${esc(city(longest.a))} ↔ ${esc(city(longest.b))} · ${plural(longest.n, 'vol', 'vols')}`, `openRouteOnMap('${longest.key}')`) : ''}
      ${frequent ? row('Trajet favori', `${frequent.a}-${frequent.b}`, `${plural(frequent.n, 'vol', 'vols')} · ${esc(city(frequent.a))} ↔ ${esc(city(frequent.b))}`, `openRouteOnMap('${frequent.key}')`) : ''}
      ${home ? row('Aéroport principal', home, `${fmtInt(passages[home])} passages · ${esc(city(home))}`, `openAirportOnMap('${home}')`) : ''}
      ${row('Tours de la Terre', (km / 40075).toFixed(1) + 'X', `${fmtInt(km)} km parcourus`, 'showDistancePopup()')}
      ${airlines.size ? row('Compagnies', String(airlines.size), 'compagnies différentes', "showView('analytics')") : ''}
      ${row('CO₂e estimé', (T.co2 / 1000).toFixed(0) + 'T', 'en classe économique, forçage radiatif inclus', 'showCO2Popup()')}
    </div>`;
  addShowMore('stamps-visited', 8);
  addShowMore('stamps-stopover', 8);
}
const mins2days = mins => (mins / 60 / 24).toFixed(1);

// From another tab: open the map on one route or one airport
function openRouteOnMap(key) {
  mapYear = '';
  mapSelection = { type: 'route', key };
  showView('map');
  focusRoute(key);
}
function openAirportOnMap(code) {
  mapYear = '';
  showView('map');
  focusAirport(code);
}

// ─── Country sheet: change the status of one country ───
function openCountrySheet(cc) {
  const info = countryInfo();
  const row = [...info.visited, ...info.stopover].find(r => r.cc === cc);
  if (!row) return;
  const list = flights.filter(f => AIRPORTS[f.from]?.country === cc || AIRPORTS[f.to]?.country === cc).sort(byDateDesc);
  const hist = routes.filter(r => AIRPORTS[r.from]?.country === cc || AIRPORTS[r.to]?.country === cc).sort((a, b) => b.count - a.count);
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
       ${hist.length ? `<div class="section-label">Historique : ${plural(hist.reduce((s, r) => s + r.count, 0), 'vol', 'vols')}</div>
       <ul class="stat-popup-list">${hist.map((r, i) => routeLi(r.from, r.to, i, `${r.count}×`, `${fmtInt(r.distKm)} km`)).join('')}</ul>` : ''}
       ${list.length ? `<div class="section-label">${plural(list.length, 'vol', 'vols')}${hist.length ? ' saisis en détail' : ''}</div>
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

// One route of the history in a popup list
function routeLi(a, b, i, value, sub) {
  return `<li>
    <span class="stat-popup-rank">${i + 1}</span>
    <span class="stat-popup-label" style="color:var(--accent2)">${esc(a)} ${a === b ? '↺' : '↔ ' + esc(b)}</span>
    <span class="stat-popup-sub">${a === b ? esc(city(a)) + ', vols locaux' : esc(city(a)) + ' ↔ ' + esc(city(b))}${sub ? ', ' + sub : ''}</span>
    <span class="stat-popup-value">${value}</span>
  </li>`;
}
// Routes of a logbook with a history, sorted by a value; used by the passport figures
function showLegsPopup(title, val, fmt, note) {
  const legs = allLegs().filter(l => val(l) > 0).sort((a, b) => val(b) - val(a));
  showStatPopup(title, `${note ? `<p class="muted" style="margin-bottom:8px">${note}</p>` : ''}
    <ul class="stat-popup-list">${legs.map((l, i) => routeLi(l.a, l.b, i, fmt(l), plural(l.n, 'vol', 'vols'))).join('')}</ul>`);
}

function showAirportsPopup() {
  if (hasHistory()) {
    const p = airportPassages();
    const rows = Object.keys(p).filter(c => AIRPORTS[c]).sort((a, b) => p[b] - p[a]).map((c, i) => `<li>
        <span class="stat-popup-rank">${i + 1}</span>
        <span class="stat-popup-label" style="color:var(--accent2);font-weight:700">${esc(c)}</span>
        <span class="stat-popup-sub">${esc(`${AIRPORTS[c].city}, ${countryName(AIRPORTS[c].country)}`)}</span>
        <span class="stat-popup-value" title="départs et arrivées">${fmtInt(p[c])}</span>
      </li>`).join('');
    showStatPopup('🏢 Aéroports, par nombre de passages', `<ul class="stat-popup-list">${rows}</ul>`);
    return;
  }
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
  if (hasHistory()) {
    showLegsPopup('🌱 Trajets par CO₂e (total)', l => l.n * calcCO2(l.km, 'economy'), l => formatCO2(l.n * calcCO2(l.km, 'economy')), 'Estimation en classe économique, forçage radiatif inclus.');
    return;
  }
  if (!flights.length) return;
  const rows = [...flights].sort((a, b) => co2Of(b) - co2Of(a))
    .map((f, i) => flightLi(f, i, formatCO2(co2Of(f)), 'color:var(--green)')).join('');
  showStatPopup('🌱 Vols par CO₂e (du plus élevé au plus faible)', `<ul class="stat-popup-list">${rows}</ul>`);
}

function showDurationPopup() {
  if (hasHistory()) {
    showLegsPopup('⏱️ Trajets par heures en vol (total)', l => l.n * estFlightMin(l.km), l => `${fmtInt(l.n * estFlightMin(l.km) / 60)} h`,
      `Heures du décollage à l'atterrissage, estimées d'après la distance : ${EST_RULE}. Règle calée sur les vols de Liv chronométrés sur Flightradar24.`);
    return;
  }
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
  if (hasHistory()) {
    showLegsPopup('🌍 Trajets par distance (du plus long au plus court)', l => l.km, l => `${fmtInt(l.km)} km`);
    return;
  }
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

// "Trajets" (logbook with a history): one line per pair of airports, history and detailed flights together
const ROUTE_SORTS = {
  count: { label: 'Plus fréquents', val: l => l.n },
  dist: { label: 'Plus longs', val: l => l.km },
  total: { label: 'Distance cumulée', val: l => l.n * l.km },
  code: { label: 'A → Z', val: null }
};
let routeSort = 'count';
let airlineSort = 'flights';   // statistics of a logbook with a history: airlines ranked by 'flights' or by 'airports'

function routeRow(l) {
  const loop = l.a === l.b;
  const A = AIRPORTS[l.a] || {}, B = AIRPORTS[l.b] || {};
  const countries = loop || A.country === B.country ? `${countryFlag(A.country)} ${esc(countryName(A.country || ''))}`
    : `${countryFlag(A.country)} ${esc(countryName(A.country || ''))} ↔ ${countryFlag(B.country)} ${esc(countryName(B.country || ''))}`;
  return `<li class="fl rt${loop ? ' loop' : ''}" ${loop ? '' : `data-route="${esc(l.key)}" tabindex="0" role="button" aria-label="Voir le trajet ${esc(l.a)} ${esc(l.b)} sur la carte"`}>
    <div class="fl-date"><b>${l.n}</b><span>${l.n > 1 ? 'vols' : 'vol'}</span></div>
    <div class="fl-route">
      <div class="fl-codes">${esc(l.a)}<i aria-hidden="true">${loop ? '↺' : '↔'}</i>${loop ? '' : esc(l.b)}</div>
      <div class="fl-sub">${loop ? `${esc(city(l.a))}, boucle sans escale` : `${esc(city(l.a))} ↔ ${esc(city(l.b))}`}</div>
    </div>
    <div class="fl-air">
      <div>${countries}</div>
      <div class="fl-sub">${l.flights ? `dont ${plural(l.flights, 'vol saisi', 'vols saisis')} en détail` : ' '}</div>
    </div>
    <div class="fl-num">
      <div>${formatDist(l.km)}</div>
      <div class="fl-sub">${l.n > 1 ? `${fmtInt(l.n * l.km)} km en tout` : ' '}</div>
    </div>
    <div class="fl-tags"></div>
  </li>`;
}

function renderRoutesTable() {
  const search = norm($('search-input').value);
  const all = allLegs();
  const legs = all.filter(l => {
    if (!search) return true;
    const A = AIRPORTS[l.a] || {}, B = AIRPORTS[l.b] || {};
    return norm([l.a, l.b, A.city, B.city, A.name, B.name, countryName(A.country || ''), countryName(B.country || '')].join(' ')).includes(search);
  });
  const s = ROUTE_SORTS[routeSort];
  legs.sort((a, b) => s.val ? (s.val(b) - s.val(a)) || a.key.localeCompare(b.key) : a.key.localeCompare(b.key));
  const n = legs.reduce((t, l) => t + l.n, 0), km = legs.reduce((t, l) => t + l.n * l.km, 0);
  $('flights-count').textContent = `${plural(legs.length, 'trajet', 'trajets')} · ${fmtInt(n)} vols · ${fmtInt(km)} km${legs.length !== all.length ? ` (sur ${all.length} trajets)` : ''}`;
  const pills = `<div class="pills" role="group" aria-label="Trier">${Object.entries(ROUTE_SORTS).map(([k, v]) =>
    `<button type="button" class="pill${k === routeSort ? ' on' : ''}" data-route-sort="${k}" aria-pressed="${k === routeSort}">${v.label}</button>`).join('')}</div>`;
  const detailed = [...flights].filter(f => {
    if (!search) return true;
    const a = AIRPORTS[f.from] || {}, b = AIRPORTS[f.to] || {};
    return norm([f.from, f.to, f.airline, f.flightNumber, a.city, b.city, f.coTravelers].join(' ')).includes(search);
  }).sort(byDateDesc);
  $('flights-table').innerHTML = pills
    + (legs.length ? `<ol class="fl-list">${legs.map(routeRow).join('')}</ol>` : '<div class="empty-state"><div class="emoji">🔍</div><p>Aucun trajet ne correspond à cette recherche.</p></div>')
    + `<section class="fl-year" style="margin-top:26px">
        <div class="fl-year-head"><h2>Vols saisis en détail</h2><span>${historyUntil ? `après le ${formatDate(historyUntil)}` : ''}</span></div>
        ${detailed.length ? `<ol class="fl-list">${detailed.map(f => flightTicket(f, true)).join('')}</ol>`
          : `<div class="empty-state" style="padding:28px 20px"><p>Les prochains vols se saisissent avec « + Ajouter un vol ». Ils comptent aussi dans les trajets ci-dessus.</p></div>`}
      </section>`;
}

function renderFlightsTable() {
  const H = hasHistory();
  $('view-flights').querySelector('.fl-title').textContent = H ? 'Trajets' : 'Mes vols';
  $('search-input').placeholder = H ? 'Aéroport, ville, pays…' : 'Aéroport, ville, compagnie, avion, accompagnant…';
  $('filter-year').hidden = H; $('sort-select').hidden = H;
  if (H) { $('filter-class').hidden = true; renderRoutesTable(); return; }
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
// Initial bearing from one [lat, lon] point to another, in degrees clockwise from north
function bearingDeg([la1, lo1], [la2, lo2]) {
  const p1 = la1 * D2R, p2 = la2 * D2R, dl = (lo2 - lo1) * D2R;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * R2D + 360) % 360;
}
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
let routeKeys = new Set(), airportCodes = new Set(), arrowKeys = new Set();
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
          arrows: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'key' },
          airports: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'code' }
        },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': p.ocean } },
          { id: 'countries-fill', type: 'fill', source: 'countries', paint: { 'fill-color': p.land } },
          { id: 'countries-line', type: 'line', source: 'countries', filter: ['!=', ['get', 'status'], 'stopover'], paint: { 'line-color': p.landLine, 'line-width': 0.6 } },
          { id: 'stopover-line', type: 'line', source: 'countries', filter: ['==', ['get', 'status'], 'stopover'], paint: { 'line-color': p.stopoverLine, 'line-width': 1, 'line-dasharray': [2, 2] } },
          { id: 'routes', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': p.route, 'line-width': ['interpolate', ['linear'], ['zoom'], 0.5, ['*', 0.55, ['min', 6, ['+', 1.5, ['*', 0.5, ['get', 'n']]]]], 3.5, ['min', 6, ['+', 1.5, ['*', 0.5, ['get', 'n']]]]], 'line-opacity': 0.8 } },
          { id: 'routes-hit', type: 'line', source: 'routes', paint: { 'line-color': '#000', 'line-width': 14, 'line-opacity': 0 } },
          // An arrow in the middle of the routes flown in one direction only
          { id: 'route-arrows', type: 'symbol', source: 'arrows',
            layout: { 'icon-image': 'route-arrow', 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
              'icon-size': ['interpolate', ['linear'], ['zoom'], 0.5, 0.35, 3.5, 0.6, 7, 0.8] },
            paint: { 'icon-color': p.route } },
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
  mapgl.on('styleimagemissing', e => {
    if (e.id !== 'route-arrow' || mapgl.hasImage('route-arrow')) return;
    // A white arrowhead pointing north; the layer colors it (SDF image)
    const size = 32, c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(16, 4); g.lineTo(28, 27); g.lineTo(16, 21); g.lineTo(4, 27); g.closePath(); g.fill();
    mapgl.addImage('route-arrow', { width: size, height: size, data: new Uint8Array(g.getImageData(0, 0, size, size).data.buffer) }, { sdf: true });
  });
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
  hover('routes-hit', p => `${p.dir === 'ba' ? `${esc(p.b)} → ${esc(p.a)}` : `${esc(p.a)} ${p.dir === 'ab' ? '→' : '↔'} ${esc(p.b)}`} · ${plural(p.n, 'vol', 'vols')}`);

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
// Pairs of airports on the map; the history (no dates) shows only when every year is on the map
function mapLegsAll() { return Object.values(legMap(mapFlights(), !mapYear)).filter(l => AIRPORTS[l.a] && AIRPORTS[l.b]); }
function usedAirports() {
  return [...new Set(mapLegsAll().flatMap(l => [l.a, l.b]))];
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
    mapgl.setPaintProperty('route-arrows', 'icon-color', ['case', ['boolean', ['feature-state', 'on'], false], p.routeOn, p.route]);
    mapgl.setPaintProperty('route-arrows', 'icon-opacity', ['case', ['boolean', ['feature-state', 'dim'], false], 0.15, 1]);

    // Countries with the passport rules
    const info = countryInfo(), status = {};
    info.visited.forEach(r => { status[r.cc] = 'visited'; });
    info.stopover.forEach(r => { status[r.cc] = 'stopover'; });
    mapgl.getSource('countries').setData(worldGeoJSON(status));

    // One line per pair of airports, both directions together. A loop (local flights) has no line.
    const legs = mapLegsAll();
    const lines = legs.filter(l => l.a !== l.b);
    routeKeys = new Set(lines.map(l => l.key));
    mapgl.getSource('routes').setData({
      type: 'FeatureCollection',
      features: lines.map(r => {
        const A = AIRPORTS[r.a], B = AIRPORTS[r.b];
        return { type: 'Feature', properties: { key: r.key, a: r.a, b: r.b, n: r.n, dir: legDir(r) },
          geometry: { type: 'LineString', coordinates: greatCirclePoints(A.lat, A.lon, B.lat, B.lon, 64).map(([la, lo]) => [lo, la]) } };
      })
    });
    const oneWay = lines.filter(l => legDir(l));
    arrowKeys = new Set(oneWay.map(l => l.key));
    mapgl.getSource('arrows').setData({
      type: 'FeatureCollection',
      features: oneWay.map(l => {
        const [A, B] = legDir(l) === 'ab' ? [AIRPORTS[l.a], AIRPORTS[l.b]] : [AIRPORTS[l.b], AIRPORTS[l.a]];
        const pts = greatCirclePoints(A.lat, A.lon, B.lat, B.lon, 64);
        return { type: 'Feature', properties: { key: l.key, bearing: bearingDeg(pts[31], pts[33]) },
          geometry: { type: 'Point', coordinates: [pts[32][1], pts[32][0]] } };
      })
    });

    const counts = {};
    legs.forEach(l => { counts[l.a] = (counts[l.a] || 0) + l.n; if (l.b !== l.a) counts[l.b] = (counts[l.b] || 0) + l.n; });
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
  const nRoutes = mapLegsAll().length;
  const info = countryInfo();
  // The country count is for the whole logbook, so it is shown only when every year is on the map
  $('map-summary').textContent = `${plural(aps.length, 'aéroport', 'aéroports')} · ${plural(nRoutes, 'trajet', 'trajets')}${mapYear ? ' en ' + mapYear : ' · ' + plural(info.visited.length, 'pays visité', 'pays visités')}`;
  const years = [...new Set(flights.map(f => f.date.slice(0, 4)))].sort().reverse();
  if (mapYear && !years.includes(mapYear)) mapYear = '';
  $('map-years').hidden = !years.length;
  $('map-years').innerHTML = ['', ...years].map(y => `<button type="button" class="pill${y === mapYear ? ' on' : ''}" data-map-year="${esc(y)}" aria-pressed="${y === mapYear}">${y ? esc(y) : hasHistory() ? 'Tout, historique compris' : 'Toutes les années'}</button>`).join('');

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

// Frames one route, with room for the side panel (or the bottom sheet on a phone)
function focusRoute(key) {
  const [a, b] = key.split('-').map(c => AIRPORTS[c]);
  if (!a || !b || !mapgl) return;
  whenMapReady(() => {
    const wide = window.innerWidth > 768;
    let pad;
    if (wide) pad = { top: 60, left: 60, bottom: 60, right: $('map-panel').offsetWidth + 60 };
    else {
      // The map is brought under the header; the bottom sheet covers its lower part
      const mapTop = document.querySelector('header').offsetHeight + 8;
      const covered = mapTop + $('map').offsetHeight - (window.innerHeight - $('map-panel').offsetHeight);
      pad = { top: 40, left: 30, right: 30, bottom: Math.max(30, covered + 30) };
    }
    if (a === b) { mapgl.easeTo({ center: [a.lon, a.lat], zoom: 7, offset: [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2], duration: 900 }); return; }
    // A route across the 180° meridian is framed the short way round
    let lonB = b.lon;
    if (lonB - a.lon > 180) lonB -= 360; else if (a.lon - lonB > 180) lonB += 360;
    mapgl.fitBounds([[Math.min(a.lon, lonB), Math.min(a.lat, b.lat)], [Math.max(a.lon, lonB), Math.max(a.lat, b.lat)]],
      { padding: pad, maxZoom: 7, duration: 900 });
  });
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
    if (arrowKeys.has(k)) mapgl.setFeatureState({ source: 'arrows', id: k }, { on, dim: !!sel && !on });
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
  if (hasHistory()) { showAirportPanelHistory(code, ap, list); return; }
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

// Airport panel of a logbook with a history: passages and links, history included; detailed flights below
function showAirportPanelHistory(code, ap, list) {
  const legs = Object.values(legMap(mapYear ? mapFlights() : flights, !mapYear)).filter(l => l.a === code || l.b === code);
  const passages = legs.reduce((s, l) => s + l.n, 0);
  const hist = legs.reduce((s, l) => s + (l.n - l.flights), 0);
  const links = legs.map(l => {
    const here = l.a === code, loop = l.a === l.b;
    return { o: here ? l.b : l.a, n: l.n, key: l.key, loop, unk: l.unk,
      out: loop ? l.n : here ? l.ab : l.ba, inn: loop ? l.n : here ? l.ba : l.ab };
  }).sort((a, b) => b.n - a.n);
  const known = links.every(x => !x.unk);
  const deps = links.reduce((s, x) => s + x.out, 0), arrs = links.reduce((s, x) => s + x.inn, 0);
  // Airlines: the Excel list for this airport, plus the detailed flights (with their count)
  const alCount = {};
  list.forEach(f => { if (f.airline) alCount[f.airline] = (alCount[f.airline] || 0) + 1; });
  const als = [...new Set([...(airportAirlines[code] || []), ...Object.keys(alCount)])];
  const arrow = x => x.loop || !x.out === !x.inn ? '' : x.out ? '→ ' : '← ';
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
      <div><b>${fmtInt(passages)}</b><span>${passages > 1 ? 'passages' : 'passage'}</span></div>
      ${known ? `<div><b>${fmtInt(deps)}</b><span>${deps > 1 ? 'décollages' : 'décollage'}</span></div>
      <div><b>${fmtInt(arrs)}</b><span>${arrs > 1 ? 'atterrissages' : 'atterrissage'}</span></div>`
      : `<div><b>${links.length}</b><span>${links.length > 1 ? 'liaisons' : 'liaison'}</span></div>
      <div><b>${list.length}</b><span>${list.length > 1 ? 'vols saisis' : 'vol saisi'}</span></div>`}
    </div>
    ${hist ? `<div class="mp-note">Dont ${plural(hist, 'vol', 'vols')} de l'historique, sans date${historyUntil ? ` (jusqu'au ${formatDate(historyUntil)})` : ''}.</div>` : ''}
    <div class="mp-label">${plural(links.length, 'liaison', 'liaisons')}${links.some(x => arrow(x)) ? ' · → départ seulement, ← arrivée seulement' : ''}</div>
    <div class="mp-chips">${links.map(x => x.loop
      ? `<span class="mp-chip"><b>${esc(code)}</b> vols locaux <span>×${x.n}</span></span>`
      : `<button type="button" class="mp-chip" data-route="${esc(x.key)}"><b>${arrow(x)}${esc(x.o)}</b> ${esc(city(x.o))} <span>×${x.n}</span></button>`).join('')}</div>
    ${als.length ? `<div class="mp-label">${plural(als.length, 'compagnie', 'compagnies')}</div>
    <div class="mp-chips">${als.map(a => `<span class="mp-chip mp-chip-static">${esc(a)}${alCount[a] ? ` <span>×${alCount[a]}</span>` : ''}</span>`).join('')}</div>` : ''}
    ${list.length ? `<div class="mp-label">Vols saisis</div>${flightRows(list, code)}` : ''}`, { type: 'airport', code });
  loadAirportPhoto(code);
}

// Airlines of a pair of airports, history included: known, deduced, or unknown
function routeAirlinesNote(leg) {
  if (!leg) return '';
  const list = Object.entries(leg.al).sort((p, q) => q[1].n - p[1].n);
  if (!list.length) return '';
  const known = list.reduce((s, [, v]) => s + v.n, 0);
  const est = list.some(([, v]) => v.est);
  const names = list.map(([name, v]) => list.length > 1 || known < leg.n ? `${esc(name)} ×${v.n}` : esc(name)).join(', ');
  const fromHist = routes.some(r => routeKey(r.from, r.to) === leg.key && r.airline);
  const why = !fromHist ? '' : est ? ' (probable : seule compagnie commune aux deux aéroports dans l\'Excel)' : ' (déduite de l\'Excel : la seule possible)';
  return `<div class="mp-note">${list.length > 1 ? 'Compagnies' : 'Compagnie'} : ${names}${why}.${known < leg.n ? ` Inconnue pour ${plural(leg.n - known, 'vol', 'vols')}.` : ''}</div>`;
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
  const hist = mapYear ? 0 : routes.filter(r => routeKey(r.from, r.to) === key).reduce((s, r) => s + r.count, 0);
  if (!list.length && !hist) return closeMapPanel();
  const airlines = [...new Set(list.map(f => f.airline).filter(Boolean))];
  const durs = list.map(f => f.durationMin).filter(m => m > 0);
  const avg = durs.length ? Math.round(durs.reduce((s, m) => s + m, 0) / durs.length) : 0;
  const total = list.length + hist;
  if (hasHistory()) {
    const km = routes.find(r => routeKey(r.from, r.to) === key)?.distKm || getDistance(a, b) || 0;
    const leg = legMap(mapYear ? mapFlights() : flights, !mapYear)[key];
    const dir = leg ? legDir(leg) : '';
    const [x, y] = dir === 'ba' ? [b, a] : [a, b], sign = dir ? '→' : '↔';
    const split = !leg || dir || leg.unk || a === b ? ''
      : `<div class="mp-note">Par sens : ${esc(a)} → ${esc(b)} ${leg.ab} · ${esc(b)} → ${esc(a)} ${leg.ba}${leg.est ? ' (répartition estimée)' : ''}.</div>`;
    openMapPanel(`
      <div class="mp-head"><div class="mp-code mp-code-route">${esc(x)}<span>${sign}</span>${esc(y)}</div></div>
      <div class="mp-sub" style="margin:-4px 0 12px">
        <button type="button" class="mp-link" data-airport="${esc(x)}">${esc(city(x))}</button> ${sign}
        <button type="button" class="mp-link" data-airport="${esc(y)}">${esc(city(y))}</button>
      </div>
      <div class="mp-stats">
        <div><b>${total}</b><span>${total > 1 ? 'vols' : 'vol'}</span></div>
        <div><b>${fmtInt(km)}</b><span>km par vol</span></div>
        <div><b>${fmtInt(km * total)}</b><span>km en tout</span></div>
      </div>
      <div class="mp-note">${hist ? `${plural(hist, 'vol', 'vols')} dans l'historique, sans date. ` : ''}Durée ${avg ? 'moyenne' : 'estimée'} : ${avg ? fmtDur(avg) : fmtDur(Math.round(estFlightMin(km)))}${avg ? ' (vols saisis)' : ' (d\'après la distance)'}.</div>
      ${dir && a !== b ? `<div class="mp-note">${leg.n > 1 ? 'Toujours' : 'Vol'} dans le sens ${esc(x)} → ${esc(y)}.</div>` : split}
      ${routeAirlinesNote(leg)}
      ${list.length ? `<div class="mp-label">Vols saisis</div>${flightRows(list)}` : ''}`, { type: 'route', key });
    return;
  }
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
    el.innerHTML = hasHistory()
      ? `<div class="empty-state"><div class="emoji">📔</div><p>Le journal raconte les voyages vol par vol, avec les dates.<br>L'historique (${fmtInt(logTotals().n)} vols, sans dates) se trouve dans les onglets Trajets et Carte.</p><button class="btn btn-primary" onclick="openModal()">+ Ajouter un vol</button></div>`
      : '<div class="empty-state"><div class="emoji">📔</div><p>Aucun vol pour l\'instant.</p><button class="btn btn-primary" onclick="openModal()">+ Ajouter le premier vol</button></div>';
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
  if (hasHistory()) { renderAnalyticsHistory(container); return; }
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

// Statistics of a logbook with a history: no dates, so no years, months, seats or aircraft.
// Everything here counts the history and the detailed flights together.
const DIST_BUCKETS = [[0, 500, 'moins de 500'], [500, 1000, '500 à 1,000'], [1000, 2500, '1,000 à 2,500'], [2500, 5000, '2,500 à 5,000'], [5000, 10000, '5,000 à 10,000'], [10000, Infinity, 'plus de 10,000']];
const HAULS = [['court', 'Court-courrier', 'moins de 1,500 km', 0, 1500, 'var(--accent)'], ['moyen', 'Moyen-courrier', '1,500 à 4,000 km', 1500, 4000, 'var(--yellow)'], ['long', 'Long-courrier', 'plus de 4,000 km', 4000, Infinity, 'var(--passport)']];

function renderAnalyticsHistory(container) {
  const T = logTotals();
  const legs = T.legs;
  const buckets = DIST_BUCKETS.map(([lo, hi]) => legs.filter(l => l.km >= lo && l.km < hi).reduce((s, l) => s + l.n, 0));
  const maxB = Math.max(...buckets), topB = buckets.indexOf(maxB);
  const hauls = HAULS.map(([k, name, range, lo, hi, color]) => {
    const ls = legs.filter(l => l.km >= lo && l.km < hi);
    return { k, name, range, color, n: ls.reduce((s, l) => s + l.n, 0), km: ls.reduce((s, l) => s + l.n * l.km, 0) };
  });
  const pct = (x, t) => t ? Math.round(x / t * 100) : 0;
  const passages = airportPassages();
  const byCountry = {};
  Object.entries(passages).forEach(([c, n]) => { const cc = AIRPORTS[c]?.country; if (cc) byCountry[cc] = (byCountry[cc] || 0) + n; });
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const topAirports = top(passages).filter(([c]) => AIRPORTS[c]);
  const topRoutes = [...legs].sort((a, b) => b.n - a.n || b.km - a.km);
  const topCountries = top(byCountry);
  // Airlines: in how many airports each one was taken or left (the Excel per airport, plus the detailed flights)
  const alAirports = {};
  const addAl = (name, code) => { (alAirports[name] = alAirports[name] || new Set()).add(code); };
  Object.entries(airportAirlines).forEach(([c, list]) => list.forEach(a => addAl(a, c)));
  flights.forEach(f => { if (f.airline) { addAl(f.airline, f.from); addAl(f.airline, f.to); } });
  airlinesList.forEach(a => { alAirports[a] = alAirports[a] || new Set(); });
  // ... and how many flights each one made: detailed flights plus the routes whose airline is deduced
  const alFlights = {};
  legs.forEach(l => Object.entries(l.al).forEach(([a, v]) => { alFlights[a] = (alFlights[a] || 0) + v.n; }));
  const withAl = Object.values(alFlights).reduce((s, n) => s + n, 0);
  const byFlights = airlineSort === 'flights';
  const topAirlines = Object.entries(alAirports).map(([a, set]) => [a, byFlights ? alFlights[a] || 0 : set.size])
    .filter(([, n]) => !byFlights || n).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'fr'));
  const rankCard = (id, title, sub) => `<section class="st-card"><div class="st-card-head"><h2>${title}</h2><span>${sub}</span></div><ol class="top-list" id="${id}"></ol></section>`;

  container.innerHTML = `
    <div class="st-head">
      <h1 class="fl-title">Statistiques</h1>
      <span class="muted">${fmtInt(T.n)} vols · ${plural(legs.length, 'trajet', 'trajets')}${historyUntil ? ` · historique jusqu'au ${formatDate(historyUntil)}` : ''}${flights.length ? ` · ${plural(flights.length, 'vol saisi', 'vols saisis')} ensuite` : ''}</span>
    </div>

    <div class="st-avg">
      <div><b>${fmtInt(T.km / T.n)} km</b><span>par vol en moyenne</span></div>
      <div><b>${fmtInt(T.mins / 60)} h</b><span>en vol (estimé)</span></div>
      <div><b>${legs.length}</b><span>trajets différents</span></div>
      <div><b>${pct(hauls[2].km, T.km)} %</b><span>des kilomètres en long-courrier</span></div>
    </div>

    <section class="st-card st-wide">
      <div class="st-card-head"><h2>Court, moyen et long-courrier</h2><span>part des vols et des kilomètres</span></div>
      <div class="haul-bar" aria-hidden="true">${hauls.map(h => `<span style="width:${pct(h.km, T.km)}%;background:${h.color}"></span>`).join('')}</div>
      <div class="hauls">${hauls.map(h => `<div class="haul">
          <div class="haul-name"><i style="background:${h.color}"></i>${h.name}<small>${h.range}</small></div>
          <div class="haul-figs"><b>${fmtInt(h.n)}</b> vols · ${pct(h.n, T.n)} %</div>
          <div class="haul-figs"><b>${fmtInt(h.km)}</b> km · ${pct(h.km, T.km)} %</div>
        </div>`).join('')}</div>
    </section>

    <section class="st-card st-wide">
      <div class="st-card-head"><h2>Distance des vols</h2><span>nombre de vols, en km</span></div>
      <div class="months buckets">${buckets.map((n, i) => `<div class="month${i === topB ? ' top' : ''}" title="${DIST_BUCKETS[i][2]} km : ${plural(n, 'vol', 'vols')}">
          <span class="mv">${n || ''}</span><span class="mb" style="height:${maxB ? Math.max(n ? 6 : 2, Math.round(n / maxB * 100)) : 2}%"></span><span class="ml">${DIST_BUCKETS[i][2]}</span></div>`).join('')}</div>
    </section>

    <div class="st-grid">
      ${rankCard('top-airports', 'Aéroports', 'passages')}
      ${rankCard('top-routes', 'Trajets', 'vols, aller et retour')}
      ${rankCard('top-countries', 'Pays', 'passages dans les aéroports')}
      <section class="st-card"><div class="st-card-head"><h2>Compagnies</h2><span>${Object.keys(alAirports).length} différentes</span></div>
        <div class="pills" role="group" aria-label="Classer les compagnies">${[['flights', 'Par vols'], ['airports', 'Par aéroports']].map(([k, label]) =>
          `<button type="button" class="pill${k === airlineSort ? ' on' : ''}" data-airline-sort="${k}" aria-pressed="${k === airlineSort}">${label}</button>`).join('')}</div>
        <ol class="top-list" id="top-airlines"></ol>
        <p class="muted" style="font-size:12px;margin-top:10px">${byFlights
          ? `Compagnie connue pour ${fmtInt(withAl)} vols sur ${fmtInt(T.n)} : saisie, ou déduite des compagnies de chaque aéroport dans l'Excel. Les autres trajets avaient plusieurs compagnies possibles.`
          : `Nombre d'aéroports où vous avez pris ou quitté chaque compagnie.`}</p>
      </section>
    </div>
    <p class="muted" style="font-size:12px;margin-top:16px">Les années, les mois, les sièges et les avions demandent des vols datés. Ils apparaîtront avec les vols saisis en détail.</p>`;

  const bar = (n, max, color) => `<div class="bar-wrap"><div class="bar" style="width:${(n / max * 100).toFixed(0)}%;background:${color}"></div></div>`;
  $('top-airports').innerHTML = topAirports.map(([c, n], i) => `<li>
      <span class="rank">${i + 1}</span><span class="rk-code">${esc(c)}</span><span class="rk-name">${esc(city(c))}</span>
      ${bar(n, topAirports[0][1], 'var(--accent)')}<span class="count">${n}</span></li>`).join('');
  $('top-routes').innerHTML = topRoutes.map((l, i) => `<li>
      <span class="rank">${i + 1}</span><span class="rk-code">${esc(l.a)} ${l.a === l.b ? '↺' : '↔ ' + esc(l.b)}</span>
      <span class="rk-name">${l.a === l.b ? esc(city(l.a)) + ', vols locaux' : esc(city(l.a)) + ' · ' + esc(city(l.b))}</span>
      ${bar(l.n, topRoutes[0].n, 'var(--yellow)')}<span class="count">${l.n}</span></li>`).join('');
  $('top-countries').innerHTML = topCountries.map(([cc, n], i) => `<li>
      <span class="rank">${i + 1}</span><span class="rk-name rk-main">${countryFlag(cc)} ${esc(countryName(cc))}</span>
      ${bar(n, topCountries[0][1], 'var(--green)')}<span class="count">${n}</span></li>`).join('');
  $('top-airlines').innerHTML = topAirlines.map(([a, n], i) => `<li>
      <span class="rank">${i + 1}</span><span class="rk-name rk-main">${esc(a)}</span>
      ${bar(n, topAirlines[0][1] || 1, 'var(--accent2)')}<span class="count">${n}</span></li>`).join('');
  ['top-airports', 'top-routes', 'top-countries', 'top-airlines'].forEach(id => addShowMore(id, 8));
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
  $('modal-title').textContent = f ? 'Modifier le vol' : `Ajouter un vol · ${CARNETS[carnet].label}`;
  // A new flight can also go to the other logbook (a flight taken together)
  $('also-other-wrap').hidden = !!f;
  $('also-other').checked = false;
  $('also-other-label').textContent = `Ajouter aussi au carnet ${CARNETS[otherCarnet()].of}`;
  $('co-travelers').placeholder = carnet === 'liv' ? 'ex. Papa, Maman' : 'ex. Liv';
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
    const alsoOther = !existing && $('also-other').checked;
    closeModal('flight-modal');
    showToast(existing ? '✅ Vol modifié et enregistré.' : '✅ Vol ajouté et enregistré.');
    renderAll();
    if (alsoOther) {
      const other = CARNETS[otherCarnet()];
      setStatus('busy', `Ajout au carnet ${other.of}…`);
      copyToOtherCarnet(flight)
        .then(r => { setStatus('ok'); showToast(r === 'exists' ? `Ce vol est déjà dans le carnet ${other.of}.` : `✅ Ajouté aussi au carnet ${other.of}.`); })
        .catch(err => { setStatus('error', err.message); showToast(`Non ajouté au carnet ${other.of}. ${err.message || ''}`, true); });
    }
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
  if (!flights.length && !hasHistory()) { showToast('Aucun vol à exporter.', true); return; }
  download(new Blob([JSON.stringify(buildDoc(), null, 2)], { type: 'application/json' }), `carnet-de-vol-${carnet}-${todayISO()}.json`);
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
  XLSX.writeFile(wb, `carnet-de-vol-${carnet}-${todayISO()}.xlsx`);
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
  const al = e.target.closest('[data-airline-sort]');
  if (al && al.dataset.airlineSort !== airlineSort) { airlineSort = al.dataset.airlineSort; renderAnalytics(); }
});
$('flights-table').addEventListener('click', e => {
  const sort = e.target.closest('[data-route-sort]');
  if (sort) { routeSort = sort.dataset.routeSort; renderRoutesTable(); return; }
  const route = e.target.closest('[data-route]');
  if (route) { openRouteOnMap(route.dataset.route); return; }
  const item = e.target.closest('.fl[data-flight]');
  if (item) openFlightDetail(item.dataset.flight);
});
$('flights-table').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const route = e.target.closest('[data-route]');
  if (route) { e.preventDefault(); openRouteOnMap(route.dataset.route); return; }
  const item = e.target.closest('.fl[data-flight]');
  if (item) { e.preventDefault(); openFlightDetail(item.dataset.flight); }
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

document.addEventListener('click', e => {
  const b = e.target.closest('[data-carnet]');
  if (b) switchCarnet(b.dataset.carnet);
});
window.addEventListener('hashchange', () => { const h = hashCarnet(); if (h && h !== carnet && cfg) switchCarnet(h); });

async function init() {
  updateThemeButton();
  carnet = hashCarnet() || storedCarnet() || 'liv';
  if (hashCarnet()) { try { localStorage.setItem(CARNET_KEY, carnet); } catch (e) {} }
  cfg = readCfg();
  if (!cfg) { showSetup(); return; }
  showApp();
  if (!hashCarnet() && !storedCarnet()) openWhoModal();
  const cached = readCache();
  if (cached?.doc) {
    try { applyDoc(cached.doc); dataSha = cached.sha || null; renderAll(); } catch (e) {}
  }
  await reloadData(true);
}
init();
