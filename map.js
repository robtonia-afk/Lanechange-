/**
 * A small slippy map for picking a point.
 *
 * No mapping library: this needs pan, zoom, and a crosshair, and a dependency
 * for that would outweigh the whole app. Web Mercator tile maths is exported
 * separately from the DOM work so it can be tested directly.
 */

export const TILE_SIZE = 256;

/* ------------------------------------------------------------------ */
/* Web Mercator                                                        */
/* ------------------------------------------------------------------ */

export function lonToTileX(lon, zoom) {
  return ((lon + 180) / 360) * 2 ** zoom;
}

export function latToTileY(lat, zoom) {
  // Clamped to the latitudes Mercator can actually represent.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom;
  // At the clamp itself the arithmetic overshoots the world by a hair, which
  // would ask for a tile row that does not exist.
  return Math.max(0, Math.min(2 ** zoom, y));
}

export function tileXToLon(x, zoom) {
  return (x / 2 ** zoom) * 360 - 180;
}

export function tileYToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Ground resolution in metres per pixel — used to size the scale bar. */
export function metresPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/* ------------------------------------------------------------------ */
/* Tile sources                                                        */
/* ------------------------------------------------------------------ */

export const LAYERS = {
  satellite: {
    label: 'Satellite',
    // Esri serves this one z/y/x, not the usual z/x/y.
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 20,
    attribution: 'Imagery © Esri',
  },
  street: {
    label: 'Street',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
};

/**
 * Which tiles cover a viewport, and where each one sits.
 * Pure, so the covering logic is testable without a browser.
 */
export function visibleTiles(center, zoom, width, height) {
  const centerX = lonToTileX(center.lon, zoom) * TILE_SIZE;
  const centerY = latToTileY(center.lat, zoom) * TILE_SIZE;
  const originX = centerX - width / 2;
  const originY = centerY - height / 2;
  const span = 2 ** zoom;

  const tiles = [];
  for (let tx = Math.floor(originX / TILE_SIZE); tx <= Math.floor((originX + width) / TILE_SIZE); tx++) {
    for (let ty = Math.floor(originY / TILE_SIZE); ty <= Math.floor((originY + height) / TILE_SIZE); ty++) {
      if (ty < 0 || ty >= span) continue; // above the pole or below it
      tiles.push({
        x: ((tx % span) + span) % span, // wrap around the date line
        y: ty,
        z: zoom,
        left: tx * TILE_SIZE - originX,
        top: ty * TILE_SIZE - originY,
      });
    }
  }
  return tiles;
}

/** The coordinate `dx, dy` pixels away from a centre at a given zoom. */
export function panned(center, zoom, dx, dy) {
  const x = lonToTileX(center.lon, zoom) * TILE_SIZE + dx;
  const y = latToTileY(center.lat, zoom) * TILE_SIZE + dy;
  return {
    lon: tileXToLon(x / TILE_SIZE, zoom),
    lat: tileYToLat(y / TILE_SIZE, zoom),
  };
}

/* ------------------------------------------------------------------ */
/* The map itself                                                      */
/* ------------------------------------------------------------------ */

export class TileMap {
  /**
   * @param {HTMLElement} container Positioned element to fill with tiles.
   * @param {object} [opts]
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.center = opts.center ?? { lat: 34.05, lon: -118.24 };
    this.zoom = opts.zoom ?? 17;
    this.minZoom = opts.minZoom ?? 3;
    this.layer = opts.layer ?? 'satellite';
    this.onChange = opts.onChange ?? (() => {});
    this.tiles = new Map();

    this.surface = document.createElement('div');
    this.surface.className = 'map-surface';
    this.container.append(this.surface);

    this.pointers = new Map();
    this.pinchFrom = null;
    this.lastTap = 0;

    this.bind();
    this.render();
  }

  get maxZoom() {
    return LAYERS[this.layer].maxZoom;
  }

  setLayer(name) {
    if (!LAYERS[name]) return;
    this.layer = name;
    this.zoom = Math.min(this.zoom, this.maxZoom);
    this.tiles.clear();
    this.surface.replaceChildren();
    this.render();
  }

  setCenter(center, zoom) {
    this.center = center;
    if (zoom != null) this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    this.render();
  }

  zoomBy(delta) {
    const next = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + delta));
    if (next === this.zoom) return;
    this.zoom = next;
    this.render();
  }

  bind() {
    const el = this.container;
    el.addEventListener('pointerdown', (event) => {
      el.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2) this.pinchFrom = { spread: this.spread(), zoom: this.zoom };
    });

    el.addEventListener('pointermove', (event) => {
      const previous = this.pointers.get(event.pointerId);
      if (!previous) return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (this.pointers.size === 1) {
        this.center = panned(this.center, this.zoom, previous.x - event.clientX, previous.y - event.clientY);
        this.render();
      } else if (this.pointers.size === 2 && this.pinchFrom) {
        // Scale the whole surface during the gesture, then settle on a real
        // zoom level when the fingers lift -- far smoother than re-tiling on
        // every move event.
        this.surface.style.transform = `scale(${this.spread() / this.pinchFrom.spread})`;
      }
    });

    const release = (event) => {
      this.pointers.delete(event.pointerId);
      if (this.pinchFrom && this.pointers.size < 2) {
        const ratio = this.spread() / this.pinchFrom.spread || 1;
        this.surface.style.transform = '';
        this.pinchFrom = null;
        if (Number.isFinite(ratio) && ratio > 0) {
          this.zoomBy(Math.round(Math.log2(ratio)));
        }
      }
      if (this.pointers.size === 0) this.onChange(this.center, this.zoom);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);

    // Double tap zooms in, which is what a thumb expects on a phone.
    el.addEventListener('click', () => {
      const now = Date.now();
      if (now - this.lastTap < 300) this.zoomBy(1);
      this.lastTap = now;
    });

    el.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.zoomBy(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  spread() {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 1;
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  render() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return; // not on screen yet

    const source = LAYERS[this.layer];
    const wanted = visibleTiles(this.center, this.zoom, width, height);
    const keep = new Set();

    for (const tile of wanted) {
      const key = `${this.layer}/${tile.z}/${tile.x}/${tile.y}`;
      keep.add(key);
      let img = this.tiles.get(key);
      if (!img) {
        img = document.createElement('img');
        img.className = 'map-tile';
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'eager';
        img.src = source.url(tile.z, tile.x, tile.y);
        this.tiles.set(key, img);
        this.surface.append(img);
      }
      img.style.transform = `translate3d(${Math.round(tile.left)}px, ${Math.round(tile.top)}px, 0)`;
    }

    for (const [key, img] of this.tiles) {
      if (!keep.has(key)) {
        img.remove();
        this.tiles.delete(key);
      }
    }

    this.onChange(this.center, this.zoom);
  }

  destroy() {
    this.surface.remove();
    this.tiles.clear();
  }
}
