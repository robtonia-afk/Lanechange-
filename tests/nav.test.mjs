import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METERS_PER_MILE,
  haversine,
  bearing,
  angleBetween,
  stageFor,
  ApproachTracker,
  AlertDirector,
  DEFAULT_SETTINGS,
  formatDistance,
  formatDuration,
  formatSpeed,
  parseCoordinates,
  speakDistance,
} from '../nav.js';

/** Move a point north by `meters`, so distances in tests are exact-ish. */
function north(from, meters) {
  return { lat: from.lat + meters / 111320, lon: from.lon };
}

const EXIT = { lat: 34.0, lon: -118.0, name: 'Exit 26' };

test('haversine measures known distances', () => {
  assert.equal(Math.round(haversine(EXIT, EXIT)), 0);
  const p = north(EXIT, 1000);
  assert.ok(Math.abs(haversine(EXIT, p) - 1000) < 5, 'within 5 m of 1 km');
});

test('bearing points the right way', () => {
  assert.ok(Math.abs(bearing(EXIT, north(EXIT, 500)) - 0) < 1);
  assert.ok(Math.abs(bearing(north(EXIT, 500), EXIT) - 180) < 1);
  assert.equal(angleBetween(350, 10), 20);
  assert.equal(angleBetween(10, 350), 20);
});

test('stageFor escalates on distance alone', () => {
  const s = DEFAULT_SETTINGS;
  assert.equal(stageFor(10 * METERS_PER_MILE, null, s), 'far');
  assert.equal(stageFor(2.5 * METERS_PER_MILE, null, s), 'headsUp');
  assert.equal(stageFor(1.0 * METERS_PER_MILE, null, s), 'moveNow');
  assert.equal(stageFor(0.2 * METERS_PER_MILE, null, s), 'final');
  assert.equal(stageFor(50, null, s), 'atExit');
});

test('stageFor escalates on time alone when still far out', () => {
  // 5 miles out but only 80 seconds away: distance says "far", time says move.
  assert.equal(stageFor(5 * METERS_PER_MILE, 80, DEFAULT_SETTINGS), 'moveNow');
  // Same distance, crawling: time is long, so distance governs.
  assert.equal(stageFor(5 * METERS_PER_MILE, 3600, DEFAULT_SETTINGS), 'far');
});

test('stageFor tolerates missing distance', () => {
  assert.equal(stageFor(null, null, DEFAULT_SETTINGS), 'idle');
  assert.equal(stageFor(NaN, null, DEFAULT_SETTINGS), 'idle');
});

test('tracker derives closing speed and ETA from successive fixes', () => {
  const start = north(EXIT, 4000);
  const tracker = new ApproachTracker(EXIT, { smoothing: 1 });
  let t = 1_000_000;
  let snap = tracker.update({ ...start, t, accuracy: 5 });
  assert.ok(Math.abs(snap.distance - 4000) < 20);
  assert.equal(snap.etaSec, null, 'no ETA from a single fix');

  // 30 m/s toward the exit (~67 mph), sampled every second.
  for (let i = 1; i <= 10; i++) {
    t += 1000;
    snap = tracker.update({ ...north(EXIT, 4000 - i * 30), t, accuracy: 5 });
  }
  assert.ok(Math.abs(snap.closingSpeed - 30) < 2, `closing ${snap.closingSpeed}`);
  assert.ok(Math.abs(snap.etaSec - snap.distance / 30) < 2);
  assert.ok(Math.abs(snap.groundSpeed - 30) < 2);
});

test('tracker ignores impossible jumps when deriving speed', () => {
  const tracker = new ApproachTracker(EXIT, { smoothing: 1 });
  let t = 0;
  let snap;
  // Steady 30 m/s approach.
  for (let i = 0; i < 5; i++) {
    t += 1000;
    snap = tracker.update({ ...north(EXIT, 5000 - i * 30), t, accuracy: 5 });
  }
  const beforeJump = snap.closingSpeed;

  // One fix teleports 3 km in a second.
  t += 1000;
  snap = tracker.update({ ...north(EXIT, 1850), t, accuracy: 5 });
  assert.equal(snap.closingSpeed, beforeJump, 'speed left alone across the jump');
  assert.ok(snap.distance < 1900, 'but the new position is still used');
  assert.ok(snap.etaSec > 30, 'ETA stays sane rather than collapsing to zero');
});

test('tracker distrusts an absurd speed reported by the device', () => {
  const tracker = new ApproachTracker(EXIT, { smoothing: 1 });
  tracker.update({ ...north(EXIT, 3000), t: 0, speed: 9999, accuracy: 5 });
  const snap = tracker.update({ ...north(EXIT, 2970), t: 1000, speed: 9999, accuracy: 5 });
  assert.ok(snap.groundSpeed < 62, `fell back to observed speed, got ${snap.groundSpeed}`);
});

test('tracker rejects wildly inaccurate fixes', () => {
  const tracker = new ApproachTracker(EXIT);
  assert.equal(tracker.update({ ...north(EXIT, 3000), t: 1, accuracy: 5000 }), null);
});

test('tracker does not call "passed" from jitter far from the exit', () => {
  const tracker = new ApproachTracker(EXIT);
  let t = 0;
  let snap;
  // Drifting away, but never got close enough for it to mean anything.
  for (let i = 0; i < 10; i++) {
    t += 1000;
    snap = tracker.update({ ...north(EXIT, 5000 + i * 40), t, accuracy: 5 });
  }
  assert.equal(snap.passed, false);
});

test('tracker detects driving past the exit', () => {
  const tracker = new ApproachTracker(EXIT);
  let t = 0;
  let snap;
  for (let d = 2000; d > 0; d -= 100) {
    t += 3000;
    snap = tracker.update({ ...north(EXIT, d), t, accuracy: 5 });
  }
  assert.equal(snap.passed, false, 'not passed while still approaching');
  // Continue through and out the far side.
  for (let d = 100; d <= 600; d += 100) {
    t += 3000;
    snap = tracker.update({ ...north(EXIT, -d), t, accuracy: 5 });
  }
  assert.equal(snap.passed, true);
});

test('director announces each stage once, in order', () => {
  const director = new AlertDirector();
  const spoken = [];
  const feed = (miles, etaSec = null) => {
    const r = director.consider({ distance: miles * METERS_PER_MILE, etaSec, passed: false });
    if (r.announce) spoken.push(r.stage);
  };

  feed(8);
  feed(4);
  feed(2.9);
  feed(2.8);
  feed(2.7);
  feed(1.4);
  feed(1.3);
  feed(0.25);
  feed(0.05);
  assert.deepEqual(spoken, ['headsUp', 'moveNow', 'final', 'atExit']);
});

test('director does not chatter while stopped on a threshold', () => {
  const director = new AlertDirector();
  let count = 0;
  // Stop-and-go traffic wobbling either side of the 1.5 mi moveNow line.
  for (const miles of [1.55, 1.45, 1.52, 1.44, 1.5, 1.48, 1.51]) {
    const r = director.consider({ distance: miles * METERS_PER_MILE, etaSec: null, passed: false });
    if (r.announce) count += 1;
  }
  assert.equal(count, 2, 'headsUp once, then moveNow once');
});

test('director starting mid-approach announces only the current stage', () => {
  const director = new AlertDirector();
  const spoken = [];
  // App started with the exit already 1.2 miles out.
  for (const miles of [1.2, 1.0, 0.8]) {
    const r = director.consider({ distance: miles * METERS_PER_MILE, etaSec: null, passed: false });
    if (r.announce) spoken.push(r.stage);
  }
  assert.deepEqual(spoken, ['moveNow'], 'no back-announced headsUp');
});

test('director rearms for a second trip at the same exit', () => {
  const director = new AlertDirector();
  const spoken = [];
  const feed = (miles) => {
    const r = director.consider({ distance: miles * METERS_PER_MILE, etaSec: null, passed: false });
    if (r.announce) spoken.push(r.stage);
  };
  feed(2.5);
  feed(1.0);
  feed(20); // drove home
  feed(2.5);
  feed(1.0);
  assert.deepEqual(spoken, ['headsUp', 'moveNow', 'headsUp', 'moveNow']);
});

test('director never walks the warning backwards mid-approach', () => {
  const director = new AlertDirector();
  const feed = (miles) =>
    director.consider({ distance: miles * METERS_PER_MILE, etaSec: null, passed: false }).stage;

  assert.equal(feed(1.4), 'moveNow');
  assert.equal(feed(1.6), 'moveNow', 'a nudge back over the line holds the stronger warning');
  assert.equal(feed(0.05), 'atExit');
  // Rolling past the exit leaves the arrival radius before "passed" is certain.
  assert.equal(feed(0.13), 'atExit', 'does not tell you to exit once you are on top of it');
});

test('director reports passing the exit', () => {
  const director = new AlertDirector();
  const r = director.consider({ distance: 400, etaSec: null, passed: true });
  assert.equal(r.stage, 'passed');
  assert.equal(r.announce, true);
});

test('formatting is readable in both unit systems', () => {
  assert.equal(formatDistance(1609.344), '1.0 mi');
  assert.equal(formatDistance(152.4), '500 ft');
  assert.equal(formatDistance(1000, 'metric'), '1.0 km');
  assert.equal(formatDistance(150, 'metric'), '150 m');
  assert.equal(formatDistance(null), '--');
  assert.equal(speakDistance(1609.344), '1.0 miles');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(125), '2m 05s');
  assert.equal(formatDuration(null), '--');
  assert.equal(formatSpeed(29.0576), '65 mph');
  assert.equal(formatSpeed(10, 'metric'), '36 km/h');
});

test('coordinates can be pasted straight in', () => {
  assert.deepEqual(parseCoordinates('34.05, -118.25'), { lat: 34.05, lon: -118.25 });
  assert.deepEqual(parseCoordinates('  34.05 -118.25 '), { lat: 34.05, lon: -118.25 });
  assert.equal(parseCoordinates('123 Main St'), null);
  assert.equal(parseCoordinates('95.0, -118.0'), null, 'latitude out of range');
});
