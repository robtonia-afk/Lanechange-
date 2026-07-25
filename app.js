import {
  METERS_PER_MILE,
  DEFAULT_SETTINGS,
  ApproachTracker,
  AlertDirector,
  labelsFor,
  announcementFor,
  speakDistance,
  formatDistance,
  formatDuration,
  formatSpeed,
  destinationPoint,
  bearing,
  haversine,
  parseCoordinates,
  severity,
} from './nav.js';
import { overpassQuery, findOpenings } from './openings.js';

const STORE = {
  settings: 'lanechange.settings.v1',
  places: 'lanechange.places.v1',
  target: 'lanechange.target.v1',
  openings: 'lanechange.openings.v1',
};

/** Restrict geocoding to one country; exit numbers are not globally unique. */
const SEARCH_COUNTRIES = 'us';

/** Search hits farther out than this are almost certainly a same-named exit elsewhere. */
const PLAUSIBLE_DRIVE_METERS = 200_000;

const $ = (id) => document.getElementById(id);

const el = {
  setup: $('setup'),
  live: $('live'),
  searchForm: $('searchForm'),
  searchInput: $('searchInput'),
  searchBtn: $('searchBtn'),
  results: $('results'),
  hereBtn: $('hereBtn'),
  savedCard: $('savedCard'),
  saved: $('saved'),
  selectedCard: $('selectedCard'),
  selectedName: $('selectedName'),
  selectedMeta: $('selectedMeta'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  liveTarget: $('liveTarget'),
  banner: $('banner'),
  distance: $('distance'),
  eta: $('eta'),
  speed: $('speed'),
  gpsPill: $('gpsPill'),
  wakePill: $('wakePill'),
  simulateBtn: $('simulateBtn'),
  simPill: $('simPill'),
  context: $('context'),
  gateState: $('gateState'),
  gateInput: $('gateInput'),
  gateSaveBtn: $('gateSaveBtn'),
  gateHereBtn: $('gateHereBtn'),
  gateClearBtn: $('gateClearBtn'),
  gateFindBtn: $('gateFindBtn'),
  gateResults: $('gateResults'),
  testVoiceBtn: $('testVoiceBtn'),
  toast: $('toast'),
  settingsDetails: $('settingsDetails'),
  voiceToggle: $('voiceToggle'),
  chimeToggle: $('chimeToggle'),
  metricToggle: $('metricToggle'),
};

const SETTING_FIELDS = [
  { meters: 'headsUpMeters', secs: 'headsUpSec', distInput: 'headsUpMiles', secInput: 'headsUpSec' },
  { meters: 'moveNowMeters', secs: 'moveNowSec', distInput: 'moveNowMiles', secInput: 'moveNowSec' },
  { meters: 'finalMeters', secs: 'finalSec', distInput: 'finalMiles', secInput: 'finalSec' },
];

const state = {
  settings: loadJSON(STORE.settings, DEFAULT_SETTINGS),
  places: loadJSON(STORE.places, []),
  target: loadJSON(STORE.target, null),
  tracker: null,
  director: null,
  watchId: null,
  simTimer: null,
  phase: 'exit',
  wakeLock: null,
  lastFixAt: null,
  staleTimer: null,
  audio: null,
  lastKnown: null,
};
state.settings = { ...DEFAULT_SETTINGS, ...state.settings };

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing / quota — the app still works for this trip */
  }
}

/* ------------------------------------------------------------------ */
/* Places                                                              */
/* ------------------------------------------------------------------ */

const sameSpot = (a, b) => a && b && haversine(a, b) < 60;

function rememberPlace(place) {
  state.places = [place, ...state.places.filter((p) => !sameSpot(p, place))].slice(0, 25);
  saveJSON(STORE.places, state.places);
  renderSaved();
}

function forgetPlace(index) {
  state.places.splice(index, 1);
  saveJSON(STORE.places, state.places);
  renderSaved();
}

function selectTarget(place) {
  state.target = place;
  saveJSON(STORE.target, place);
  rememberPlace(place);
  renderSelected();
  el.selectedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

el.searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = el.searchInput.value.trim();
  if (!query) return;

  const coords = parseCoordinates(query);
  if (coords) {
    selectTarget({ ...coords, name: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`, meta: 'Pasted coordinates' });
    el.results.hidden = true;
    return;
  }

  el.searchBtn.disabled = true;
  el.searchBtn.textContent = '…';
  try {
    const places = await geocode(query);
    renderResults(places);
  } catch (error) {
    toast(navigator.onLine ? 'Search failed. Try again.' : 'Search needs a connection — saved exits still work offline.');
    console.error(error);
  } finally {
    el.searchBtn.disabled = false;
    el.searchBtn.textContent = 'Search';
  }
});

async function geocode(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '8');
  url.searchParams.set('addressdetails', '1');
  // Exit numbers repeat all over the world. Without this, "exit 26" matches in
  // whichever country Nominatim scores highest, which is rarely this one.
  url.searchParams.set('countrycodes', SEARCH_COUNTRIES);

  // Bias toward where the phone already is, when we know it, so "exit 26"
  // finds the one on your commute rather than one three states away.
  const near = await cachedPosition();
  if (near) {
    const pad = 1.5;
    url.searchParams.set(
      'viewbox',
      [near.lon - pad, near.lat + pad, near.lon + pad, near.lat - pad].join(','),
    );
  }

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const raw = await response.json();

  const places = raw.map((item) => {
    const parts = String(item.display_name || '').split(', ');
    return {
      lat: Number(item.lat),
      lon: Number(item.lon),
      name: item.name || parts[0] || 'Unnamed place',
      meta: parts.slice(1, 4).join(', '),
    };
  });

  if (!near) return places;

  // Nominatim's own ranking is better at "which of these is an exit" than
  // distance is, so keep its order -- but push anything too far away to be on
  // today's drive below the rest, which is what separates the Exit 26 near you
  // from the identically named one three states over.
  for (const p of places) p.away = haversine(near, p);
  const plausible = places.filter((p) => p.away <= PLAUSIBLE_DRIVE_METERS);
  const distant = places.filter((p) => p.away > PLAUSIBLE_DRIVE_METERS);
  return [...plausible, ...distant];
}

function renderResults(places) {
  el.results.innerHTML = '';
  if (!places.length) {
    el.results.hidden = true;
    toast('Nothing found. Try the cross-street at the end of the ramp.');
    return;
  }
  for (const place of places) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const meta = [place.meta, place.away != null ? `${formatDistance(place.away, state.settings.units)} away` : null]
      .filter(Boolean)
      .join(' • ');
    button.innerHTML = `<div class="result-name"></div><div class="result-meta"></div>`;
    button.querySelector('.result-name').textContent = place.name;
    button.querySelector('.result-meta').textContent = meta;
    button.addEventListener('click', () => {
      selectTarget({ lat: place.lat, lon: place.lon, name: place.name, meta: place.meta });
      el.results.hidden = true;
      el.results.innerHTML = '';
    });
    li.append(button);
    el.results.append(li);
  }
  el.results.hidden = false;
}

el.hereBtn.addEventListener('click', () => {
  el.hereBtn.disabled = true;
  el.hereBtn.textContent = 'Getting a fix…';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      el.hereBtn.disabled = false;
      el.hereBtn.textContent = "Save the spot I'm at right now";
      const { latitude: lat, longitude: lon } = position.coords;
      const name = prompt('Name this exit', 'My exit');
      if (name === null) return;
      selectTarget({ lat, lon, name: name.trim() || 'My exit', meta: 'Saved from GPS' });
    },
    (error) => {
      el.hereBtn.disabled = false;
      el.hereBtn.textContent = "Save the spot I'm at right now";
      toast(geoErrorMessage(error));
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
});

/**
 * A position to bias search towards.
 *
 * Safari does not support querying the geolocation permission -- the call
 * throws rather than answering -- so an unanswerable query has to mean "ask",
 * not "give up". Treating it as give-up disabled the bias entirely on the one
 * platform this app is for, and searching "I-405 exit 26" returned exits in
 * Iran. Only an explicit denial skips the prompt.
 */
async function cachedPosition() {
  if (state.lastKnown) return state.lastKnown;

  let denied = false;
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    denied = status?.state === 'denied';
  } catch {
    denied = false; // Unsupported query tells us nothing; fall through and ask.
  }
  if (denied) return null;

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        state.lastKnown = { lat: position.coords.latitude, lon: position.coords.longitude };
        resolve(state.lastKnown);
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Tracking                                                            */
/* ------------------------------------------------------------------ */

el.startBtn.addEventListener('click', start);
el.simulateBtn.addEventListener('click', startSimulation);
el.stopBtn.addEventListener('click', stop);
el.testVoiceBtn.addEventListener('click', () => {
  chime('moveNow');
  speak('Get out of the H O V lane now.');
});

/** Shared setup for a real drive and a simulated one. */
function beginSession(opening) {
  // Audio and speech have to be unlocked inside the tap that starts things,
  // or iOS stays silent for the rest of the drive.
  primeAudio();
  speak(opening);

  // With an opening set, the first leg counts down to it rather than to the
  // ramp — crossing the buffer is the deadline you can actually miss.
  state.phase = state.target.gate ? 'gate' : 'exit';
  state.tracker = new ApproachTracker(aimPoint());
  state.director = new AlertDirector(state.settings);
  state.lastFixAt = null;

  el.live.dataset.stage = 'idle';
  el.liveTarget.textContent = state.target.name;
  el.banner.textContent = labelsFor(state.phase).idle;
  el.context.hidden = true;
  el.distance.textContent = '—';
  el.eta.textContent = '—';
  el.speed.textContent = '—';
  el.live.hidden = false;
  el.setup.hidden = true;
}

function start() {
  if (!state.target) return;
  if (!navigator.geolocation) {
    toast('This browser has no GPS access.');
    return;
  }

  el.simPill.hidden = true;
  beginSession(`Tracking ${state.target.name}. I'll tell you when to move over.`);

  state.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 20000,
  });

  state.staleTimer = setInterval(checkFixAge, 3000);
  requestWakeLock();
}

/**
 * Replay a scripted 67 mph approach through the exact same pipeline the real
 * GPS feed uses, at 5x, so the alerts can be checked from a parked car.
 */
function startSimulation() {
  if (!state.target) return;

  el.simPill.hidden = false;
  beginSession(`Simulating the approach to ${state.target.name}.`);
  el.gpsPill.textContent = 'GPS: simulated';

  const SPEED = 30; // m/s, about 67 mph
  const lead = Math.max(state.settings.headsUpMeters * 1.4, 1200);
  const exit = state.target;
  const gate = state.target.gate;

  // Lay a straight track along the real gate-to-exit direction so the whole
  // trip plays out: run up to the opening, through it, then on to the ramp.
  // With no opening set it is just a straight run in from the south.
  const course = gate ? bearing(gate, exit) : 0;
  const origin = destinationPoint(gate ?? exit, (course + 180) % 360, lead);
  const total = lead + (gate ? haversine(gate, exit) : 0) + 450;

  let travelled = 0;
  let clock = Date.now();

  state.simTimer = setInterval(() => {
    if (travelled > total) {
      stop();
      toast('Simulation finished.');
      return;
    }
    const point = destinationPoint(origin, course, travelled);
    clock += 1000;
    onFix({
      coords: {
        latitude: point.lat,
        longitude: point.lon,
        speed: SPEED,
        accuracy: 6,
        heading: course,
      },
      timestamp: clock,
    });
    travelled += SPEED;
  }, 200);
}

function stop() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  clearInterval(state.staleTimer);
  state.staleTimer = null;
  clearInterval(state.simTimer);
  state.simTimer = null;
  el.simPill.hidden = true;
  releaseWakeLock();
  try { speechSynthesis.cancel(); } catch { /* not supported */ }
  el.live.hidden = true;
  el.setup.hidden = false;
}

function onFix(position) {
  const c = position.coords;
  state.lastKnown = { lat: c.latitude, lon: c.longitude };
  state.lastFixAt = Date.now();

  const snap = state.tracker.update({
    lat: c.latitude,
    lon: c.longitude,
    t: position.timestamp || Date.now(),
    speed: c.speed,
    heading: c.heading,
    accuracy: c.accuracy,
  });
  if (!snap) {
    el.gpsPill.textContent = 'GPS: weak signal';
    el.gpsPill.classList.add('warn');
    return;
  }

  el.gpsPill.textContent = `GPS: ±${Math.round(snap.accuracy ?? 0)} m`;
  el.gpsPill.classList.toggle('warn', (snap.accuracy ?? 0) > 60);

  const { stage, announce } = state.director.consider(snap);
  render(snap, stage, { lat: c.latitude, lon: c.longitude });

  if (announce) {
    chime(stage);
    speak(announcementFor(stage, snap, state.target, state.settings.units, state.phase));
  }

  // Through the opening: the rest of the trip is an ordinary run at the ramp,
  // so re-aim at the exit and start its staging fresh.
  if (state.phase === 'gate' && (stage === 'atExit' || stage === 'passed')) {
    handOffToExit({ lat: c.latitude, lon: c.longitude });
  }
}

/** The point the countdown is currently aimed at. */
function aimPoint() {
  return state.phase === 'gate' && state.target.gate
    ? { ...state.target.gate, name: 'the opening' }
    : state.target;
}

function handOffToExit(here) {
  state.phase = 'ramp';
  state.tracker = new ApproachTracker(state.target);
  state.director = new AlertDirector(state.settings);
  const left = haversine(here, state.target);
  speak(
    `You're out of the H O V lane. ${state.target.name} in ` +
      `${speakDistance(left, state.settings.units)}.`,
  );
}

function render(snap, stage, here) {
  el.live.dataset.stage = stage;
  el.banner.textContent = labelsFor(state.phase)[stage] ?? '';
  el.distance.textContent = formatDistance(snap.distance, state.settings.units);
  el.eta.textContent = snap.etaSec != null ? formatDuration(snap.etaSec) : 'no ETA';
  el.speed.textContent = formatSpeed(snap.groundSpeed, state.settings.units);

  // While aiming at the opening, keep the ramp visible so the numbers on
  // screen never look like they contradict the road signs.
  if (state.phase === 'gate' && here) {
    const toExit = haversine(here, state.target);
    el.context.textContent =
      `${state.target.name} — ${formatDistance(toExit, state.settings.units)} past the opening`;
    el.context.hidden = false;
  } else {
    el.context.hidden = true;
  }
}

function onFixError(error) {
  el.gpsPill.textContent = `GPS: ${geoErrorMessage(error)}`;
  el.gpsPill.classList.add('warn');
  if (error.code === error.PERMISSION_DENIED) {
    toast('Location is blocked. Settings → Safari → Location → Allow.');
    stop();
  }
}

function checkFixAge() {
  if (!state.lastFixAt) return;
  const age = (Date.now() - state.lastFixAt) / 1000;
  if (age > 12) {
    el.gpsPill.textContent = `GPS: no fix for ${Math.round(age)}s`;
    el.gpsPill.classList.add('warn');
  }
}

function geoErrorMessage(error) {
  if (!error) return 'unavailable';
  if (error.code === error.PERMISSION_DENIED) return 'permission denied';
  if (error.code === error.POSITION_UNAVAILABLE) return 'position unavailable';
  if (error.code === error.TIMEOUT) return 'timed out';
  return 'error';
}

/* ------------------------------------------------------------------ */
/* Sound                                                               */
/* ------------------------------------------------------------------ */

function primeAudio() {
  // Always unlock, even with the chime off — this tap is the only chance iOS
  // gives us, and the setting can be switched on later.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    state.audio ||= new Ctx();
    if (state.audio.state === 'suspended') state.audio.resume();
  } catch {
    state.audio = null;
  }
}

/** One beep for a heads-up, escalating to three sharp ones at the last call. */
function chime(stage) {
  if (!state.settings.chime || !state.audio) return;
  const beeps = Math.min(3, Math.max(1, severity(stage) - severity('headsUp') + 1));
  const pitch = stage === 'final' ? 1180 : stage === 'moveNow' ? 900 : 720;
  for (let i = 0; i < beeps; i++) at(state.audio.currentTime + i * 0.22, pitch);

  function at(time, frequency) {
    const osc = state.audio.createOscillator();
    const gain = state.audio.createGain();
    osc.type = 'triangle';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.35, time + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
    osc.connect(gain).connect(state.audio.destination);
    osc.start(time);
    osc.stop(time + 0.2);
  }
}

function speak(text) {
  if (!state.settings.voice || !text) return;
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.volume = 1.0;
    speechSynthesis.speak(utterance);
  } catch {
    /* speech is a bonus; the screen still shows the warning */
  }
}

/* ------------------------------------------------------------------ */
/* Wake lock                                                           */
/* ------------------------------------------------------------------ */

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    el.wakePill.hidden = false;
    el.wakePill.classList.add('warn');
    el.wakePill.textContent = 'Set Auto-Lock to Never';
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    el.wakePill.hidden = false;
    el.wakePill.classList.remove('warn');
    el.wakePill.textContent = 'Screen staying on';
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch {
    el.wakePill.hidden = false;
    el.wakePill.classList.add('warn');
    el.wakePill.textContent = 'Set Auto-Lock to Never';
  }
}

function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch { /* already gone */ }
  state.wakeLock = null;
  el.wakePill.hidden = true;
}

// Coming back from a phone call or a lock drops the wake lock — take it again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.watchId != null && !state.wakeLock) {
    requestWakeLock();
  }
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function unitDivisor() {
  return state.settings.units === 'metric' ? 1000 : METERS_PER_MILE;
}

function renderSettings() {
  const metric = state.settings.units === 'metric';
  for (const field of SETTING_FIELDS) {
    $(field.distInput).value = (state.settings[field.meters] / unitDivisor()).toFixed(2).replace(/\.?0+$/, '');
    $(field.secInput).value = String(Math.round(state.settings[field.secs]));
  }
  for (const node of document.querySelectorAll('.u-dist')) node.textContent = metric ? 'km' : 'mi';
  el.voiceToggle.checked = !!state.settings.voice;
  el.chimeToggle.checked = !!state.settings.chime;
  el.metricToggle.checked = metric;
}

function readSettings() {
  for (const field of SETTING_FIELDS) {
    const dist = Number($(field.distInput).value);
    const secs = Number($(field.secInput).value);
    if (Number.isFinite(dist) && dist > 0) state.settings[field.meters] = dist * unitDivisor();
    if (Number.isFinite(secs) && secs > 0) state.settings[field.secs] = secs;
  }
  state.settings.voice = el.voiceToggle.checked;
  state.settings.chime = el.chimeToggle.checked;
  saveJSON(STORE.settings, state.settings);
  state.director?.updateSettings(state.settings);
  renderSelected();
}

for (const field of SETTING_FIELDS) {
  $(field.distInput).addEventListener('change', readSettings);
  $(field.secInput).addEventListener('change', readSettings);
}
el.voiceToggle.addEventListener('change', readSettings);
el.chimeToggle.addEventListener('change', readSettings);
el.metricToggle.addEventListener('change', () => {
  state.settings.units = el.metricToggle.checked ? 'metric' : 'imperial';
  saveJSON(STORE.settings, state.settings);
  renderSettings();
  renderSaved();
  renderSelected();
});

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderSaved() {
  el.saved.innerHTML = '';
  el.savedCard.hidden = state.places.length === 0;
  state.places.forEach((place, index) => {
    const li = document.createElement('li');

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'pick';
    pick.innerHTML = `<div class="saved-name"></div><div class="saved-meta"></div>`;
    pick.querySelector('.saved-name').textContent = place.name;
    pick.querySelector('.saved-meta').textContent =
      place.meta || `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`;
    pick.addEventListener('click', () => selectTarget(place));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.setAttribute('aria-label', `Delete ${place.name}`);
    del.textContent = '×';
    del.addEventListener('click', () => forgetPlace(index));

    li.append(pick, del);
    el.saved.append(li);
  });
}

function renderSelected() {
  el.selectedCard.hidden = !state.target;
  if (!state.target) return;
  el.selectedName.textContent = state.target.name;

  const warnAt = formatDistance(state.settings.moveNowMeters, state.settings.units);
  const aimedAt = state.target.gate ? 'the opening' : 'the exit';
  el.selectedMeta.textContent =
    `${state.target.meta ? state.target.meta + ' — ' : ''}warns you ${warnAt} before ${aimedAt}`;

  const gate = state.target.gate;
  el.gateState.textContent = gate
    ? `${gate.lat.toFixed(5)}, ${gate.lon.toFixed(5)}`
    : 'not set';
  el.gateState.classList.toggle('set', !!gate);
  el.gateClearBtn.hidden = !gate;
  el.gateInput.value = '';
}

/** Store an HOV opening against the selected exit. */
function setGate(coords) {
  state.target = { ...state.target, gate: coords };
  saveJSON(STORE.target, state.target);
  state.places = state.places.map((p) => (sameSpot(p, state.target) ? state.target : p));
  saveJSON(STORE.places, state.places);
  renderSaved();
  renderSelected();
}

el.gateSaveBtn.addEventListener('click', () => {
  const coords = parseCoordinates(el.gateInput.value);
  if (!coords) {
    toast('Enter the opening as coordinates, like 34.0632, -118.2887.');
    return;
  }
  setGate(coords);
  toast('Opening set. The countdown now runs to it.');
});

el.gateHereBtn.addEventListener('click', () => {
  el.gateHereBtn.disabled = true;
  el.gateHereBtn.textContent = 'Getting a fix…';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      el.gateHereBtn.disabled = false;
      el.gateHereBtn.textContent = 'Use where I am now';
      setGate({ lat: position.coords.latitude, lon: position.coords.longitude });
      toast('Opening set from your current spot.');
    },
    (error) => {
      el.gateHereBtn.disabled = false;
      el.gateHereBtn.textContent = 'Use where I am now';
      toast(geoErrorMessage(error));
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
});

/**
 * Ask OpenStreetMap where the buffer opens near this exit.
 *
 * Results are candidates, never applied automatically: OSM reflects when
 * someone last mapped the road, not when Caltrans last restriped it, so the
 * markings you can see always win.
 */
el.gateFindBtn.addEventListener('click', async () => {
  if (!state.target) return;
  const cacheKey = `${STORE.openings}.${state.target.lat.toFixed(4)},${state.target.lon.toFixed(4)}`;

  el.gateFindBtn.disabled = true;
  el.gateFindBtn.textContent = 'Looking…';
  try {
    let elements = loadJSON(cacheKey, null);
    if (!elements) {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: overpassQuery(state.target),
      });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      elements = (await response.json()).elements ?? [];
      saveJSON(cacheKey, elements);
    }
    renderOpenings(findOpenings(elements, state.target));
  } catch (error) {
    console.error(error);
    toast(
      navigator.onLine
        ? 'OpenStreetMap lookup failed. Try again, or set the opening by hand.'
        : 'That lookup needs a connection.',
    );
  } finally {
    el.gateFindBtn.disabled = false;
    el.gateFindBtn.textContent = 'Look up in OpenStreetMap';
  }
});

function renderOpenings(openings) {
  el.gateResults.innerHTML = '';
  if (!openings.length) {
    el.gateResults.hidden = true;
    toast('No mapped openings on this stretch. Set it by hand from the road or satellite view.');
    return;
  }
  for (const opening of openings) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = `<div class="result-name"></div><div class="result-meta"></div>`;
    button.querySelector('.result-name').textContent =
      `Opening ${formatDistance(opening.distance, state.settings.units)} before the exit`;
    button.querySelector('.result-meta').textContent = [
      opening.road,
      `${formatDistance(opening.length, state.settings.units)} long`,
      'from OpenStreetMap — check it against the road',
    ]
      .filter(Boolean)
      .join(' • ');
    button.addEventListener('click', () => {
      setGate({ lat: opening.lat, lon: opening.lon });
      el.gateResults.hidden = true;
      el.gateResults.innerHTML = '';
      toast('Opening set. Confirm it matches the striping on your first run.');
    });
    li.append(button);
    el.gateResults.append(li);
  }
  el.gateResults.hidden = false;
}

el.gateClearBtn.addEventListener('click', () => {
  const { gate, ...withoutGate } = state.target;
  state.target = withoutGate;
  saveJSON(STORE.target, state.target);
  state.places = state.places.map((p) => (sameSpot(p, state.target) ? state.target : p));
  saveJSON(STORE.places, state.places);
  renderSaved();
  renderSelected();
  toast('Opening removed. Counting down to the exit again.');
});

function toast(message, ms = 4200) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

renderSettings();
renderSaved();
renderSelected();

// Reaching this line means the module graph loaded and ran, so the standing
// failure notice can go, and the build stamp tells us which copy is running.
document.getElementById('bootError')?.remove();
const build = document.querySelector('meta[name="build"]')?.content;
if (build) $('buildStamp').textContent = build;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  });
}
