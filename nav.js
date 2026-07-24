/**
 * Pure navigation math and alert-stage logic.
 *
 * No DOM, no browser APIs -- this module is imported by both the app and the
 * Node test suite. Keep it that way.
 */

export const METERS_PER_MILE = 1609.344;
export const METERS_PER_FOOT = 0.3048;
const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance between two {lat, lon} points, in meters. */
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, in degrees clockwise from true north. */
export function bearing(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute angle between two bearings, 0..180 degrees. */
export function angleBetween(a, b) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/* ------------------------------------------------------------------ */
/* Alert stages                                                        */
/* ------------------------------------------------------------------ */

export const STAGES = ['idle', 'far', 'headsUp', 'moveNow', 'final', 'atExit', 'passed'];

/** Higher number = more urgent. Used to decide when to re-announce. */
export function severity(stage) {
  const i = STAGES.indexOf(stage);
  return i < 0 ? 0 : i;
}

/**
 * Defaults tuned for freeway HOV lanes: you generally need well over a mile
 * to work across three or four lanes of traffic at speed.
 */
export const DEFAULT_SETTINGS = {
  headsUpSec: 180,
  headsUpMeters: 3.0 * METERS_PER_MILE,
  moveNowSec: 90,
  moveNowMeters: 1.5 * METERS_PER_MILE,
  finalSec: 30,
  finalMeters: 0.3 * METERS_PER_MILE,
  arriveMeters: 150,
  units: 'imperial',
  voice: true,
  chime: true,
};

/**
 * Pick the alert stage for a given distance / ETA.
 *
 * Distance and time are checked independently and whichever fires first wins,
 * so the alert still lands early when traffic is crawling (time is long but
 * distance is short) or when moving fast (distance is long but time is short).
 */
export function stageFor(distanceM, etaSec, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (distanceM == null || !Number.isFinite(distanceM)) return 'idle';
  const reached = (meters, secs) =>
    distanceM <= meters || (etaSec != null && Number.isFinite(etaSec) && etaSec <= secs);

  if (distanceM <= s.arriveMeters) return 'atExit';
  if (reached(s.finalMeters, s.finalSec)) return 'final';
  if (reached(s.moveNowMeters, s.moveNowSec)) return 'moveNow';
  if (reached(s.headsUpMeters, s.headsUpSec)) return 'headsUp';
  return 'far';
}

/* ------------------------------------------------------------------ */
/* Approach tracking                                                   */
/* ------------------------------------------------------------------ */

/**
 * Turns a stream of raw GPS fixes into a stable picture of the approach:
 * distance to the target, how fast that distance is actually closing, and the
 * resulting ETA.
 *
 * Closing speed is used rather than raw ground speed because it is what
 * actually matters here -- it already accounts for the road not pointing
 * straight at the exit, and it goes negative the moment you drive past.
 */
export class ApproachTracker {
  /**
   * @param {{lat:number, lon:number}} target
   * @param {object} [opts]
   * @param {number} [opts.smoothing] EMA weight for new samples, 0..1.
   * @param {number} [opts.maxAccuracy] Drop fixes worse than this, in meters.
   * @param {number} [opts.minIntervalMs] Ignore fixes closer together than this.
   * @param {number} [opts.armPassedMeters] Only call "passed" once we got this close.
   * @param {number} [opts.maxSpeed] Implied speeds above this mean a bad fix, in m/s.
   */
  constructor(target, opts = {}) {
    this.target = target;
    this.smoothing = opts.smoothing ?? 0.35;
    this.maxAccuracy = opts.maxAccuracy ?? 200;
    this.minIntervalMs = opts.minIntervalMs ?? 500;
    this.armPassedMeters = opts.armPassedMeters ?? 1200;
    this.maxSpeed = opts.maxSpeed ?? 62; // ~139 mph
    this.reset();
  }

  reset() {
    this.last = null;
    this.closingSpeed = null;
    this.groundSpeed = null;
    this.minDistance = Infinity;
    this.recedingCount = 0;
    this.armed = false;
    this.passed = false;
  }

  setTarget(target) {
    this.target = target;
    this.reset();
  }

  /**
   * Feed a fix.
   * @param {{lat:number, lon:number, t:number, speed?:number|null, accuracy?:number|null}} fix
   * @returns {object|null} Snapshot of the approach, or null if the fix was rejected.
   */
  update(fix) {
    if (!this.target) return null;
    if (fix.accuracy != null && fix.accuracy > this.maxAccuracy) return null;

    const distance = haversine(fix, this.target);
    const prev = this.last;

    if (prev) {
      const dt = (fix.t - prev.t) / 1000;
      if (dt < this.minIntervalMs / 1000) return this.snapshot(distance, fix);

      // A jump no car could make means one of the two fixes is junk. Keep the
      // new position, but don't let the implied speed poison the ETA -- an
      // inflated closing speed would fire "exit now" miles too early.
      const jumped = haversine(prev, fix) / dt > this.maxSpeed;

      if (!jumped) {
        // Positive when the gap to the target is shrinking.
        const closing = (prev.distance - distance) / dt;
        this.closingSpeed = blend(this.closingSpeed, closing, this.smoothing);

        const ground =
          fix.speed != null && fix.speed >= 0 && fix.speed <= this.maxSpeed
            ? fix.speed
            : haversine(prev, fix) / dt;
        this.groundSpeed = blend(this.groundSpeed, ground, this.smoothing);
      }

      // Require several consecutive receding fixes so GPS jitter at a red
      // light doesn't announce that you missed the exit.
      if (distance > prev.distance + 5) this.recedingCount += 1;
      else if (distance < prev.distance - 5) this.recedingCount = 0;
    } else if (fix.speed != null && fix.speed >= 0) {
      this.groundSpeed = fix.speed;
    }

    if (distance < this.minDistance) this.minDistance = distance;
    if (distance <= this.armPassedMeters) this.armed = true;
    if (this.armed && this.recedingCount >= 3 && distance > this.minDistance + 200) {
      this.passed = true;
    }

    this.last = { lat: fix.lat, lon: fix.lon, t: fix.t, distance };
    return this.snapshot(distance, fix);
  }

  snapshot(distance, fix) {
    // Below walking pace the ETA is noise, not information.
    const closing = this.closingSpeed != null && this.closingSpeed > 1.0 ? this.closingSpeed : null;
    const etaSec = closing ? distance / closing : null;
    return {
      distance,
      etaSec,
      closingSpeed: this.closingSpeed,
      groundSpeed: this.groundSpeed,
      bearingToTarget: bearing(fix, this.target),
      heading: fix.heading ?? null,
      passed: this.passed,
      accuracy: fix.accuracy ?? null,
    };
  }
}

function blend(current, sample, weight) {
  if (!Number.isFinite(sample)) return current;
  if (current == null || !Number.isFinite(current)) return sample;
  return current * (1 - weight) + sample * weight;
}

/* ------------------------------------------------------------------ */
/* Announcements                                                       */
/* ------------------------------------------------------------------ */

/**
 * Decides which stage changes are worth speaking out loud.
 *
 * Each stage is announced once. The slate is only wiped when you back well
 * away from the target (a new trip, or a rerouted approach), so sitting in
 * traffic on a threshold never produces a stream of repeats.
 */
export class AlertDirector {
  constructor(settings = DEFAULT_SETTINGS) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.announced = new Set();
    this.stage = 'idle';
    this.peak = 'idle';
  }

  updateSettings(settings) {
    this.settings = { ...this.settings, ...settings };
  }

  reset() {
    this.announced = new Set();
    this.stage = 'idle';
    this.peak = 'idle';
  }

  /**
   * @param {object} snap Output of ApproachTracker#update.
   * @returns {{stage:string, changed:boolean, announce:boolean}}
   */
  consider(snap) {
    if (!snap) return { stage: this.stage, changed: false, announce: false };

    // Clearly back off the approach -> treat the next run at it as fresh.
    if (snap.distance > this.settings.headsUpMeters * 1.25 && !snap.passed) {
      this.announced.clear();
      this.peak = 'idle';
    }

    const raw = stageFor(snap.distance, snap.etaSec, this.settings);
    let stage;
    if (snap.passed) {
      stage = 'passed';
    } else {
      // Warnings only ever get more urgent within one approach. Without this,
      // creeping back over a threshold in traffic -- or rolling past the exit
      // and out of the arrival radius -- walks the banner backwards and tells
      // you to exit when the ramp is behind you.
      stage = severity(raw) >= severity(this.peak) ? raw : this.peak;
      this.peak = stage;
    }

    const changed = stage !== this.stage;
    this.stage = stage;

    const worthSaying = severity(stage) >= severity('headsUp');
    const announce = worthSaying && !this.announced.has(stage);
    if (announce) {
      // Mark quieter stages as spoken too, so starting mid-approach doesn't
      // later back-announce a warning you've already driven past.
      for (const s of STAGES) {
        if (severity(s) <= severity(stage)) this.announced.add(s);
      }
    }
    return { stage, changed, announce };
  }
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatDistance(meters, units = 'imperial') {
  if (meters == null || !Number.isFinite(meters)) return '--';
  if (units === 'metric') {
    if (meters >= 1000) return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
    return `${Math.round(meters / 10) * 10} m`;
  }
  const miles = meters / METERS_PER_MILE;
  if (miles >= 0.19) return `${miles.toFixed(miles >= 10 ? 0 : 1)} mi`;
  return `${Math.round(meters / METERS_PER_FOOT / 50) * 50} ft`;
}

/** Spoken form -- "1.4 miles" reads better than "1.4 mi". */
export function speakDistance(meters, units = 'imperial') {
  if (meters == null || !Number.isFinite(meters)) return 'unknown distance';
  if (units === 'metric') {
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} kilometers`;
    return `${Math.round(meters / 10) * 10} meters`;
  }
  const miles = meters / METERS_PER_MILE;
  if (miles >= 0.19) return `${miles.toFixed(1)} miles`;
  return `${Math.round(meters / METERS_PER_FOOT / 50) * 50} feet`;
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 10) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  return `${mins} min`;
}

export function formatSpeed(mps, units = 'imperial') {
  if (mps == null || !Number.isFinite(mps)) return '--';
  return units === 'metric'
    ? `${Math.round(mps * 3.6)} km/h`
    : `${Math.round((mps / METERS_PER_MILE) * 3600)} mph`;
}

export const STAGE_LABELS = {
  idle: 'Waiting for GPS',
  far: 'On the way',
  headsUp: 'Heads up',
  moveNow: 'Get out of the HOV lane',
  final: 'Exit now',
  atExit: 'At your exit',
  passed: 'Exit passed',
};

/** What the app says out loud when a stage is first reached. */
export function announcementFor(stage, snap, target, units = 'imperial') {
  const name = target?.name ? target.name : 'your exit';
  const dist = speakDistance(snap?.distance, units);
  switch (stage) {
    case 'headsUp':
      return `Heads up. ${name} in ${dist}. Start working your way out of the H O V lane.`;
    case 'moveNow':
      return `Get out of the H O V lane now. ${name} in ${dist}.`;
    case 'final':
      return `Take the exit. ${name} is right ahead.`;
    case 'atExit':
      return `You are at ${name}.`;
    case 'passed':
      return `You passed ${name}.`;
    default:
      return '';
  }
}

/** Accepts "34.05, -118.25" style input so a raw coordinate can be pasted in. */
export function parseCoordinates(text) {
  const m = String(text)
    .trim()
    .match(/^(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
