import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TILE_SIZE,
  lonToTileX,
  latToTileY,
  tileXToLon,
  tileYToLat,
  metresPerPixel,
  visibleTiles,
  panned,
  LAYERS,
} from '../map.js';
import { haversine } from '../nav.js';

const LA = { lat: 34.0522, lon: -118.2437 };

test('tile coordinates round-trip back to the same place', () => {
  for (const zoom of [3, 10, 17, 20]) {
    const lon = tileXToLon(lonToTileX(LA.lon, zoom), zoom);
    const lat = tileYToLat(latToTileY(LA.lat, zoom), zoom);
    assert.ok(Math.abs(lon - LA.lon) < 1e-9, `lon at z${zoom}`);
    assert.ok(Math.abs(lat - LA.lat) < 1e-9, `lat at z${zoom}`);
  }
});

test('known tile numbers match the standard scheme', () => {
  // Zoom 0 is a single tile and the origin is the top-left of the world.
  assert.equal(Math.floor(lonToTileX(-180, 0)), 0);
  assert.equal(Math.floor(lonToTileX(0, 1)), 1);
  assert.equal(Math.floor(latToTileY(0, 1)), 1);
  assert.equal(Math.floor(lonToTileX(LA.lon, 10)), 175);
  assert.equal(Math.floor(latToTileY(LA.lat, 10)), 408);
});

test('latitude is clamped to what Mercator can represent', () => {
  assert.ok(Number.isFinite(latToTileY(90, 10)), 'the north pole must not blow up');
  assert.ok(Number.isFinite(latToTileY(-90, 10)));
  assert.ok(latToTileY(90, 10) >= 0);
  assert.ok(latToTileY(-90, 10) <= 2 ** 10);
});

test('resolution is fine enough to see lane markings at max zoom', () => {
  const perPixel = metresPerPixel(LA.lat, LAYERS.satellite.maxZoom);
  assert.ok(perPixel < 0.2, `${perPixel} m/px — striping has to be visible`);
  assert.ok(metresPerPixel(LA.lat, 10) > 100, 'and coarse when zoomed out');
});

test('visibleTiles covers the viewport with the centre in the middle', () => {
  const tiles = visibleTiles(LA, 17, 400, 700);
  assert.ok(tiles.length >= 6, `covers the viewport, got ${tiles.length}`);

  // Every pixel of the viewport must be inside some tile.
  const left = Math.min(...tiles.map((t) => t.left));
  const top = Math.min(...tiles.map((t) => t.top));
  const right = Math.max(...tiles.map((t) => t.left + TILE_SIZE));
  const bottom = Math.max(...tiles.map((t) => t.top + TILE_SIZE));
  assert.ok(left <= 0 && top <= 0, 'no gap at the top left');
  assert.ok(right >= 400 && bottom >= 700, 'no gap at the bottom right');

  // No duplicates.
  const keys = tiles.map((t) => `${t.x}/${t.y}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('visibleTiles wraps across the date line and skips off-world rows', () => {
  const tiles = visibleTiles({ lat: 0, lon: 179.99 }, 2, 512, 512);
  assert.ok(tiles.every((t) => t.x >= 0 && t.x < 4), 'x wraps into range');
  assert.ok(tiles.every((t) => t.y >= 0 && t.y < 4), 'no rows above the pole');
});

test('panning moves the centre the right way and the right distance', () => {
  const zoom = 17;
  // Drag content left by 100 px => the centre moves east.
  const east = panned(LA, zoom, 100, 0);
  assert.ok(east.lon > LA.lon, 'panning right moves east');
  assert.ok(Math.abs(east.lat - LA.lat) < 1e-9, 'and not north or south');

  const south = panned(LA, zoom, 0, 100);
  assert.ok(south.lat < LA.lat, 'panning down moves south');

  // 100 px should be 100 px worth of ground.
  const expected = metresPerPixel(LA.lat, zoom) * 100;
  assert.ok(
    Math.abs(haversine(LA, east) - expected) < expected * 0.02,
    `moved ${haversine(LA, east)} m, expected about ${expected} m`,
  );
});

test('panning back and forth returns to the start', () => {
  const there = panned(LA, 18, 250, -140);
  const back = panned(there, 18, -250, 140);
  assert.ok(Math.abs(back.lat - LA.lat) < 1e-9);
  assert.ok(Math.abs(back.lon - LA.lon) < 1e-9);
});

test('tile URLs follow each provider’s axis order', () => {
  // Esri puts y before x; getting this backwards silently serves wrong imagery.
  assert.match(LAYERS.satellite.url(17, 22539, 52350), /\/17\/52350\/22539$/);
  assert.match(LAYERS.street.url(17, 22539, 52350), /\/17\/22539\/52350\.png$/);
});
