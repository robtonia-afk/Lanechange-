/**
 * Finding HOV lane openings in OpenStreetMap data.
 *
 * The whole approach rests on one property of OSM: mappers split a highway way
 * wherever the lane markings change. So a segment whose carpool lane is tagged
 * as crossable IS an opening in the buffer -- its first node, in the direction
 * of travel, is the point where you may start moving right.
 *
 * Pure functions only; the network call lives in app.js so this stays testable.
 */

import { haversine, bearing, angleBetween } from './nav.js';

/** Ways farther than this from the exit are not part of this approach. */
export const DEFAULT_SEARCH_RADIUS = 12000;

/**
 * Overpass QL for carpool-lane openings around a point.
 * Also valid to paste into overpass-turbo.eu for a look at the raw data.
 */
export function overpassQuery(point, radius = DEFAULT_SEARCH_RADIUS) {
  const lat = Number(point.lat).toFixed(6);
  const lon = Number(point.lon).toFixed(6);
  return [
    '[out:json][timeout:30];',
    `way(around:${Math.round(radius)},${lat},${lon})`,
    '["highway"~"^(motorway|trunk)$"]["change:lanes"];',
    'out tags geom;',
  ].join('\n');
}

/**
 * The per-lane change values, left to right in the direction of travel.
 * Oneway motorways carry the plain key; some ways use the :forward variant.
 */
export function laneValues(tags = {}) {
  const raw = tags['change:lanes'] ?? tags['change:lanes:forward'];
  if (!raw) return null;
  const values = String(raw).split('|').map((v) => v.trim());
  return values.length ? values : null;
}

/**
 * Which lane is the carpool lane. `hov:lanes` names it outright when mapped;
 * otherwise assume leftmost, which is how California builds them.
 */
export function hovLaneIndex(tags = {}) {
  const hov = tags['hov:lanes'] ?? tags['hov:lanes:forward'];
  if (hov) {
    const idx = String(hov).split('|').findIndex((v) => v.trim() === 'designated');
    if (idx >= 0) return idx;
  }
  return 0;
}

/**
 * Whether the tag value permits leaving the carpool lane -- which, from the
 * leftmost lane, means moving right.
 *
 * `not_left` forbids only a move to the left, so moving right is still allowed;
 * `not_right` is the one that pins you in. Returns null when unmapped.
 */
export function canLeaveHovLane(value) {
  switch (String(value ?? '').trim()) {
    case 'yes':
    case 'not_left':
      return true;
    case 'no':
    case 'not_right':
      return false;
    default:
      return null;
  }
}

function pathLength(geometry) {
  let total = 0;
  for (let i = 1; i < geometry.length; i++) total += haversine(geometry[i - 1], geometry[i]);
  return total;
}

/**
 * Turn an Overpass response into candidate openings, nearest to the exit first.
 *
 * Divided highways carry each direction as its own way, and the two sit only a
 * few metres apart, so position alone cannot tell them apart. Direction can:
 * a way whose travel heading points towards the exit is the carriageway you
 * are on, and the other one is dropped.
 *
 * @param {Array} elements Overpass `elements`, fetched with `out tags geom`.
 * @param {{lat:number, lon:number}} exit
 */
export function findOpenings(elements = [], exit, opts = {}) {
  const maxDistance = opts.maxDistance ?? DEFAULT_SEARCH_RADIUS;
  const found = [];

  for (const element of elements) {
    if (element?.type !== 'way') continue;
    const geometry = element.geometry;
    if (!Array.isArray(geometry) || geometry.length < 2) continue;

    const tags = element.tags ?? {};
    const lanes = laneValues(tags);
    if (!lanes) continue;
    if (canLeaveHovLane(lanes[hovLaneIndex(tags)]) !== true) continue;

    const start = { lat: geometry[0].lat, lon: geometry[0].lon };
    const end = { lat: geometry.at(-1).lat, lon: geometry.at(-1).lon };
    const middle = geometry[Math.floor(geometry.length / 2)];

    // Wrong carriageway, or a segment heading away from the exit entirely.
    const travel = bearing(start, end);
    const towardsExit = bearing({ lat: middle.lat, lon: middle.lon }, exit);
    if (angleBetween(travel, towardsExit) > 90) continue;

    const distance = haversine(start, exit);
    if (distance > maxDistance) continue;

    found.push({
      lat: start.lat,
      lon: start.lon,
      distance,
      length: pathLength(geometry),
      road: tags.ref || tags.name || null,
      wayId: element.id ?? null,
    });
  }

  return found.sort((a, b) => a.distance - b.distance);
}
