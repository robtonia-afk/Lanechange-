import test from 'node:test';
import assert from 'node:assert/strict';

import {
  overpassQuery,
  laneValues,
  hovLaneIndex,
  canLeaveHovLane,
  findOpenings,
} from '../openings.js';
import { haversine } from '../nav.js';

// A north-running freeway with the exit at the top.
const EXIT = { lat: 34.05, lon: -118.0 };
const north = (m) => ({ lat: EXIT.lat - (2000 - m) / 111320, lon: EXIT.lon });

/** A way running north (towards the exit) from `startBack` metres short of it. */
function way(id, tags, startBack, lengthM, { southbound = false, offsetLon = 0 } = {}) {
  const a = { lat: EXIT.lat - startBack / 111320, lon: EXIT.lon + offsetLon };
  const b = { lat: EXIT.lat - (startBack - lengthM) / 111320, lon: EXIT.lon + offsetLon };
  return {
    type: 'way',
    id,
    tags,
    geometry: southbound ? [b, a] : [a, b],
  };
}

test('overpassQuery targets change:lanes on motorways around the point', () => {
  const q = overpassQuery({ lat: 34.0632, lon: -118.2887 }, 8000);
  assert.match(q, /\[out:json\]\[timeout:30\];/);
  assert.match(q, /way\(around:8000,34\.063200,-118\.288700\)/);
  assert.match(q, /\["change:lanes"\]/);
  assert.match(q, /highway.*motorway\|trunk/);
  assert.match(q, /out tags geom;/, 'geometry is needed to locate the opening');
});

test('laneValues splits left to right and handles the forward variant', () => {
  assert.deepEqual(laneValues({ 'change:lanes': 'no|yes|yes' }), ['no', 'yes', 'yes']);
  assert.deepEqual(laneValues({ 'change:lanes:forward': 'yes|no' }), ['yes', 'no']);
  assert.equal(laneValues({}), null);
});

test('hovLaneIndex prefers the mapped designated lane, else leftmost', () => {
  assert.equal(hovLaneIndex({ 'hov:lanes': 'designated|yes|yes' }), 0);
  assert.equal(hovLaneIndex({ 'hov:lanes': 'yes|designated|yes' }), 1);
  assert.equal(hovLaneIndex({}), 0, 'California builds them on the left');
});

test('canLeaveHovLane reads the restriction from the carpool lane outward', () => {
  assert.equal(canLeaveHovLane('yes'), true);
  assert.equal(canLeaveHovLane('no'), false);
  // From the leftmost lane, leaving means moving right.
  assert.equal(canLeaveHovLane('not_left'), true, 'blocked leftward, but right is open');
  assert.equal(canLeaveHovLane('not_right'), false, 'this is the one that pins you in');
  assert.equal(canLeaveHovLane(''), null);
  assert.equal(canLeaveHovLane(undefined), null);
});

test('findOpenings returns crossable segments nearest the exit first', () => {
  const elements = [
    way(1, { 'change:lanes': 'no|no|no' }, 3000, 900),      // buffer
    way(2, { 'change:lanes': 'yes|yes|yes' }, 2000, 400),   // opening, 2 km back
    way(3, { 'change:lanes': 'no|no|no' }, 1600, 800),      // buffer
    way(4, { 'change:lanes': 'yes|yes|yes' }, 700, 300),    // opening, 700 m back
  ];
  const found = findOpenings(elements, EXIT);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((o) => o.wayId), [4, 2], 'nearest to the exit first');
  assert.ok(Math.abs(found[0].distance - 700) < 20);
  assert.ok(Math.abs(found[0].length - 300) < 20, 'reports how long the opening is');
});

test('findOpenings uses the start of the opening, not its middle or end', () => {
  const [opening] = findOpenings([way(1, { 'change:lanes': 'yes|yes' }, 1500, 500)], EXIT);
  // The gate is where the buffer breaks: the far end, 1500 m short of the exit.
  assert.ok(Math.abs(haversine(opening, EXIT) - 1500) < 20);
});

test('findOpenings drops the opposite carriageway', () => {
  const elements = [
    way(1, { 'change:lanes': 'yes|yes' }, 1200, 400),
    // Same place, a few metres over, running the other way.
    way(2, { 'change:lanes': 'yes|yes' }, 1200, 400, { southbound: true, offsetLon: 0.0004 }),
  ];
  const found = findOpenings(elements, EXIT);
  assert.deepEqual(found.map((o) => o.wayId), [1], 'only the side heading to the exit');
});

test('findOpenings respects the designated lane when it is not leftmost', () => {
  const tags = { 'hov:lanes': 'yes|designated|yes', 'change:lanes': 'yes|no|yes' };
  assert.deepEqual(findOpenings([way(1, tags, 1000, 300)], EXIT), [], 'carpool lane is closed');

  const open = { 'hov:lanes': 'yes|designated|yes', 'change:lanes': 'no|yes|no' };
  assert.equal(findOpenings([way(2, open, 1000, 300)], EXIT).length, 1);
});

test('findOpenings ignores unusable and far-away input', () => {
  assert.deepEqual(findOpenings([], EXIT), []);
  assert.deepEqual(findOpenings([{ type: 'node', id: 1, lat: 34, lon: -118 }], EXIT), []);
  assert.deepEqual(findOpenings([{ type: 'way', id: 2, tags: {} }], EXIT), [], 'no geometry');
  assert.deepEqual(
    findOpenings([way(3, { 'change:lanes': 'yes|yes' }, 60000, 400)], EXIT),
    [],
    'beyond the search radius',
  );
  assert.deepEqual(
    findOpenings([way(4, { lanes: '4' }, 1000, 400)], EXIT),
    [],
    'no change:lanes tag at all — the common real-world case',
  );
});

test('unmapped restrictions are not treated as permission to cross', () => {
  const found = findOpenings([way(1, { 'change:lanes': '||' }, 1000, 400)], EXIT);
  assert.deepEqual(found, [], 'empty values mean unknown, not yes');
});
