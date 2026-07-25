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
 * Which tiles cover a viewport, and where and how big each one is drawn.
 *
 * `zoom` is fractional so the view can scale continuously; tiles themselves
 * only exist at whole zoom levels, so they are drawn from `tileZoom` and
 * stretched by the difference. That is what makes pinching smooth instead of
 * jumping a factor of two at a time.
 */
export function visibleTiles(center, zoom, width, height, tileZoom = Math.round(zoom)) {
  const size = TILE_SIZE * 2 ** (zoom - tileZoom);
  const centerX = lonToTileX(center.lon, tileZoom) * size;
  const centerY = latToTileY(center.lat, tileZoom) * size;
  const originX = centerX - width / 2;
  const originY = centerY - height / 2;
  const span = 2 ** tileZoom;

  const tiles = [];
  for (let tx = Math.floor(originX / size); tx <= Math.floor((originX + width) / size); tx++) {
    for (let ty = Math.floor(originY / size); ty <= Math.floor((originY + height) / size); ty++) {
      if (ty < 0 || ty >= span) continue; // above the pole or below it
      tiles.push({
        x: ((tx % span) + span) % span, // wrap around the date line
        y: ty,
        z: tileZoom,
        left: tx * size - originX,
        top: ty * size - originY,
        size,
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
    this.retiring = new Map();
    this.frame = 0;

    this.surface = document.createElement('div');
    this.surface.className = 'map-surface';
    this.container.append(this.surface);

    this.pointers = new Map();
    this.pinchFrom = null;
    this.lastTap = 0;

    this.bind();
    this.render();
  }

  /** Tiles stop at the provider's limit; the view may go a little past it. */
  get tileMaxZoom() {
    return LAYERS[this.layer].maxZoom;
  }

  get maxZoom() {
    // A bit of over-zoom past native resolution: blurrier, but it lets you
    // place the crosshair on a stripe rather than near it.
    return this.tileMaxZoom + 1.5;
  }

  setLayer(name) {
    if (!LAYERS[name]) return;
    this.layer = name;
    this.zoom = Math.min(this.zoom, this.maxZoom);
    for (const timer of this.retiring.values()) clearTimeout(timer);
    this.retiring.clear();
    for (const img of this.tiles.values()) img.remove();
    this.tiles.clear();
    this.render();
  }

  setCenter(center, zoom) {
    this.center = center;
    if (zoom != null) this.zoom = this.clampZoom(zoom);
    this.render();
  }

  clampZoom(zoom) {
    return Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
  }

  zoomBy(delta) {
    this.zoomTo(this.zoom + delta);
  }

  zoomTo(zoom) {
    const next = this.clampZoom(zoom);
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
        // Follow the fingers continuously. Snapping to whole levels at the end
        // of the gesture makes every pinch feel like a lurch.
        const ratio = this.spread() / this.pinchFrom.spread;
        if (Number.isFinite(ratio) && ratio > 0) {
          this.zoom = this.clampZoom(this.pinchFrom.zoom + Math.log2(ratio));
          this.render();
        }
      }
    });

    const release = (event) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinchFrom = null;
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
      // Proportional to the actual scroll, not one whole level per notch.
      this.zoomBy(Math.max(-1, Math.min(1, -event.deltaY / 240)));
    }, { passive: false });
  }

  spread() {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 1;
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  /** Coalesce bursts of pan/pinch events into one paint per frame. */
  render() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return; // not on screen yet

    const source = LAYERS[this.layer];
    const tileZoom = Math.max(this.minZoom, Math.min(this.tileMaxZoom, Math.round(this.zoom)));
    const wanted = visibleTiles(this.center, this.zoom, width, height, tileZoom);
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
        // A tile that fails should leave a gap, not a broken-image icon.
        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        img.src = source.url(tile.z, tile.x, tile.y);
        this.tiles.set(key, img);
        this.surface.append(img);
      }
      // Sub-pixel positions here, because rounding at fractional zoom leaves
      // hairline seams between tiles.
      img.style.width = `${tile.size}px`;
      img.style.height = `${tile.size}px`;
      img.style.transform = `translate3d(${tile.left}px, ${tile.top}px, 0)`;
      img.style.zIndex = '2';
    }

    // Tiles from the level we just left stay underneath until the new ones
    // have arrived, so crossing a zoom boundary doesn't flash empty.
    for (const [key, img] of this.tiles) {
      if (keep.has(key)) continue;
      img.style.zIndex = '1';
      if (!this.retiring.has(key)) {
        this.retiring.set(key, setTimeout(() => {
          img.remove();
          this.tiles.delete(key);
          this.retiring.delete(key);
        }, 400));
      }
    }
    for (const key of keep) {
      const timer = this.retiring.get(key);
      if (timer) {
        clearTimeout(timer);
        this.retiring.delete(key);
      }
    }

    this.onChange(this.center, this.zoom);
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const timer of this.retiring.values()) clearTimeout(timer);
    this.retiring.clear();
    this.surface.remove();
    this.tiles.clear();
  }
}
