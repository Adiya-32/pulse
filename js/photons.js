// photons.js — a Monte Carlo light simulation in a side cut through the skin under the watch.
// Coordinates: x along the arm (0 = middle of the watch), d = depth below the skin surface.
//
// Blood is not a uniform red fill: the vessels hold individual red blood cells, and it is the
// haemoglobin inside them that absorbs light. A photon takes random steps (scattering off
// tissue); on each step we work out exactly how far it travelled through red blood cells,
// and the chance it survives is e^(−μ_Hb × that distance) × e^(−μ_tissue × step).
// When the pulse wave widens a vessel, more cells fit inside: more haemoglobin in the way.
//
// The geometry is exaggerated so it can be seen (real green light reaches ~1 mm, real cells are
// 7 µm), but the rules are the real ones.

export const HALF_W = 3;               // the cut spans x ∈ [−3, 3]
export const LEDS = [-0.16, 0.16];     // LED centres on the back of the watch
export const LED_HALF = 0.07;
export const SENSORS = [-0.56, 0.56];  // photodiode centres
export const SENSOR_HALF = 0.14;
export const EPI = 0.07;               // top layer of skin (epidermis, with melanin)
export const DERMIS = 0.58;            // dermis: where the tiny arteries are
export const FAT = 1.0;                // below: fat, then the artery and muscle
export const MAX_D = 1.75;

export const CELL_R = 0.017;           // red blood cell radius (scene units)
export const HCT = 0.32;               // fraction of a vessel's area filled by cells (haematocrit)

// Tiny arteries (arterioles) in the dermis: wavy bands, centre depth d + amp·sin(k·x + ph).
// They widen as each pulse wave passes: this is where the watch's signal comes from.
export const ARTERIOLES = [
  { d: 0.15, r: 0.03, amp: 0.018, k: 2.3, ph: 0.4 },
  { d: 0.31, r: 0.034, amp: 0.02, k: 1.7, ph: 2.1 },
  { d: 0.47, r: 0.038, amp: 0.022, k: 1.3, ph: 4.0 },
];
export const ARTERIOLE_SWELL = 0.65;    // exaggerated so it can be seen (real: a few %)
// A vein: blood flowing back to the heart at low, steady pressure. Its cells absorb light too,
// but it doesn't widen with the heartbeat, so it adds no rhythm.
export const VEIN = { d: 0.7, r: 0.07 };
// A deeper artery (the kind you feel with a finger). Green light barely reaches it.
export const ARTERY = { d: 1.2, r: 0.14 };
export const ARTERY_SWELL = 0.2;

// Per colour, in 1/unit: scattering, absorption by tissue, by haemoglobin (inside a red blood
// cell), by melanin. Haemoglobin absorbs green far more than red (real ratio ~100×, compressed
// here so both colours show something); melanin absorbs green most; red/infrared scatter less.
export const OPTICS = {
  green: { mus: 14, muaT: 0.35, muaHb: 30, muaM: 2.5 },
  red:   { mus: 10, muaT: 0.12, muaHb: 0.45, muaM: 1.2 },
  ir:    { mus: 9,  muaT: 0.1,  muaHb: 0.8, muaM: 0.8 },
};

export const arterioleCentre = (a, x) => a.d + a.amp * Math.sin(a.k * x + a.ph);

// The vessels, in drawing/physics order. kind: 'artery' (oxygen-rich) or 'vein'.
// flow(q): how fast the cells move along x (positive = towards the hand), q = pulse 0..1.
export const VESSELS = [
  ...ARTERIOLES.map((a) => ({ kind: 'artery', centre: (x) => arterioleCentre(a, x), r0: a.r, swell: ARTERIOLE_SWELL, flow: (q) => 0.06 + 0.5 * q })),
  { kind: 'vein', centre: () => VEIN.d, r0: VEIN.r, swell: 0, flow: () => -0.12 },
  { kind: 'artery', centre: () => ARTERY.d, r0: ARTERY.r, swell: ARTERY_SWELL, flow: (q) => 0.1 + 0.9 * q },
];
export const radiusAt = (v, q) => v.r0 * (1 + v.swell * q);

// ---------------------------------------------------------------------------------------------
// Red blood cells. Each vessel has a fixed pool of cells, enough to fill it at its widest. A cell
// sits at a lateral offset s (−1…1, as a fraction of the widest radius); it is inside the vessel
// only while |s| × widest radius < current radius. So when the vessel widens, more of the pool is
// inside: more blood. Each cell moves with the blood at its own position, so where the pulse
// wave is passing the cells surge forward, and elsewhere they creep.
export class Blood {
  constructor(seed = 11) {
    let st = seed >>> 0;
    const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296);
    this.pool = VESSELS.map((v) => {
      const rmax = radiusAt(v, 1);
      const n = Math.round((HCT * 2 * rmax * 2 * HALF_W) / (Math.PI * CELL_R * CELL_R));
      return Array.from({ length: n }, () => ({ x: -HALF_W + 2 * HALF_W * rnd(), s: 2 * rnd() - 1, tilt: rnd() }));
    });
    let id = 0; this.pool.forEach((p) => p.forEach((c) => { c.id = id++; }));
    this.count = id;
  }
  // move the cells along their vessels; q(x) is the pulse along the arm
  advance(dt, q) {
    const W2 = 2 * HALF_W;
    VESSELS.forEach((v, vi) => {
      for (const c of this.pool[vi]) {
        c.x += v.flow(q(c.x)) * dt;
        c.x = ((((c.x + HALF_W) % W2) + W2) % W2) - HALF_W;
      }
    });
  }

  // Where every cell inside a vessel is right now. `pulse` is a number or a function of x.
  layout(pulse) {
    const q = typeof pulse === 'function' ? pulse : () => pulse;
    const L = new Layout();
    VESSELS.forEach((v, vi) => {
      const rmax = radiusAt(v, 1);
      for (const c of this.pool[vi]) {
        const x = c.x;
        const off = c.s * rmax;
        if (Math.abs(off) > radiusAt(v, q(x))) continue;      // outside the vessel at the moment
        L.add(x, v.centre(x) + off, vi, c.id, c.tilt);
      }
    });
    L.index();
    return L;
  }
}

// The cells' positions plus a coarse grid, so each light step checks only nearby cells.
const GRID = 0.08, GX = Math.ceil((2 * HALF_W) / GRID) + 1, GD = Math.ceil(MAX_D / GRID) + 1;
export class Layout {
  constructor() { this.x = []; this.d = []; this.v = []; this.id = []; this.tilt = []; this.byId = new Map(); }
  add(x, d, v, id, tilt) { this.byId.set(id, this.x.length); this.x.push(x); this.d.push(d); this.v.push(v); this.id.push(id); this.tilt.push(tilt); }
  index() {
    this.grid = Array.from({ length: GX * GD }, () => null);
    for (let i = 0; i < this.x.length; i++) {
      const gx = Math.floor((this.x[i] + HALF_W) / GRID), gd = Math.floor(this.d[i] / GRID);
      if (gx < 0 || gx >= GX || gd < 0 || gd >= GD) continue;
      (this.grid[gd * GX + gx] ||= []).push(i);
    }
  }
  // Length of the segment (x0,d0)→(x1,d1) that lies inside red blood cells, and the cell
  // that segment passes through most (and where along the segment, 0..1).
  cellPath(x0, d0, x1, d1) {
    const dx = x1 - x0, dd = d1 - d0, len2 = dx * dx + dd * dd, len = Math.sqrt(len2);
    let total = 0, best = -1, bestL = 0, bestT = 0;
    if (len2 < 1e-12) return { total, best, bestT };
    const gxa = Math.max(0, Math.floor((Math.min(x0, x1) - CELL_R + HALF_W) / GRID)), gxb = Math.min(GX - 1, Math.floor((Math.max(x0, x1) + CELL_R + HALF_W) / GRID));
    const gda = Math.max(0, Math.floor((Math.min(d0, d1) - CELL_R) / GRID)), gdb = Math.min(GD - 1, Math.floor((Math.max(d0, d1) + CELL_R) / GRID));
    for (let gd = gda; gd <= gdb; gd++) for (let gx = gxa; gx <= gxb; gx++) {
      const list = this.grid[gd * GX + gx]; if (!list) continue;
      for (const i of list) {
        // where the line enters and leaves this cell's circle
        const fx = x0 - this.x[i], fd = d0 - this.d[i];
        const b = (fx * dx + fd * dd) / len2, c = (fx * fx + fd * fd - CELL_R * CELL_R) / len2;
        const disc = b * b - c; if (disc <= 0) continue;
        const sq = Math.sqrt(disc), t0 = Math.max(0, -b - sq), t1 = Math.min(1, -b + sq);
        if (t1 <= t0) continue;
        const L = (t1 - t0) * len; total += L;
        if (L > bestL) { bestL = L; best = i; bestT = (t0 + t1) / 2; }
      }
    }
    return { total, best, bestT };
  }
}

// ---------------------------------------------------------------------------------------------
function start(rand) {
  const x = LEDS[rand() < 0.5 ? 0 : 1] + (rand() - 0.5) * 2 * LED_HALF;
  const th = (rand() - 0.5) * 2.2;            // aim downward, with a wide spread
  return { x, d: 0.001, th };
}
const atSensor = (x) => SENSORS.some((s) => Math.abs(x - s) < SENSOR_HALF);
const scatter = (th, rand) => th + (rand() - 0.5) * 2.4 + (rand() - 0.5) * 2.4;   // mildly forward

// One random-walk step for a photon at state st = {x, d, th}. Decides where it goes next and
// whether something absorbs it on the way. Returns { x, d } (end of this step) and, if the photon
// ends here, fate ('detected' | 'escaped' | 'absorbed') and by ('blood' | 'vein' | 'pigment' |
// 'tissue'), plus cellId when a red blood cell swallowed it.
export function step(st, led, layout, melanin, rand) {
  const o = OPTICS[led];
  const s = -Math.log(1 - rand()) / o.mus;
  let nx = st.x + Math.sin(st.th) * s, nd = st.d + Math.cos(st.th) * s, frac = 1, exits = false;
  if (nd <= 0) { frac = st.d / (st.d - nd); nx = st.x + (nx - st.x) * frac; nd = 0; exits = true; }
  if (Math.abs(nx) > HALF_W || nd > MAX_D) return { x: nx, d: nd, fate: 'escaped' };
  const len = s * frac;
  const cp = layout.cellPath(st.x, st.d, nx, nd);
  const epi = (st.d < EPI || nd < EPI) ? Math.min(len, EPI * 2) : 0;
  const tHb = o.muaHb * cp.total, tT = o.muaT * len, tM = o.muaM * melanin * epi, tau = tHb + tT + tM;
  if (rand() < 1 - Math.exp(-tau)) {
    const r = rand() * tau;
    if (r < tHb && cp.best >= 0) {
      return { x: layout.x[cp.best], d: layout.d[cp.best], fate: 'absorbed', by: VESSELS[layout.v[cp.best]].kind === 'vein' ? 'vein' : 'blood', cellId: layout.id[cp.best] };
    }
    return { x: nx, d: nd, fate: 'absorbed', by: r < tHb + tM ? 'pigment' : 'tissue' };
  }
  if (exits) return { x: nx, d: 0, fate: atSensor(nx) ? 'detected' : 'escaped' };
  st.x = nx; st.d = nd; st.th = scatter(st.th, rand);
  return { x: nx, d: nd };
}

export function startPhoton(led, melanin, rand = Math.random) {
  const st = start(rand);
  const o = OPTICS[led];
  const pigment = rand() > Math.exp(-o.muaM * melanin * EPI);   // stopped by melanin on the way in
  return { st, pigment };
}

// A whole photon, all-or-nothing. Returns { path, fate, by, cellId }.
export function traceVisible(led, layout, melanin, rand = Math.random) {
  const { st, pigment } = startPhoton(led, melanin, rand);
  const path = [st.x, 0];
  if (pigment) return { path, fate: 'absorbed', by: 'pigment' };
  for (let i = 0; i < 300; i++) {
    const r = step(st, led, layout, melanin, rand);
    path.push(r.x, r.d);
    if (r.fate) return { path, ...r };
  }
  return { path, fate: 'absorbed', by: 'tissue' };
}

// Low-noise "weight" method used by tissue-optics codes (e.g. MCML): instead of an
// all-or-nothing absorption, each step multiplies the packet's weight by the fraction that
// survives, e^(−(μ_Hb·distance in cells + μ_tissue·step + μ_melanin·distance in epidermis)).
// A packet with very little weight left plays "Russian roulette" so the average stays fair.
export function tracePhoton(led, layout, melanin, rand = Math.random) {
  const o = OPTICS[led];
  let { x, d, th } = start(rand), w = Math.exp(-o.muaM * melanin * EPI);
  for (let k = 0; k < 300; k++) {
    const s = -Math.log(1 - rand()) / o.mus;
    let nx = x + Math.sin(th) * s, nd = d + Math.cos(th) * s, frac = 1, exits = false;
    if (nd <= 0) { frac = d / (d - nd); nx = x + (nx - x) * frac; nd = 0; exits = true; }
    if (Math.abs(nx) > HALF_W || nd > MAX_D) return { weight: 0, fate: 'escaped' };
    const len = s * frac, cp = layout.cellPath(x, d, nx, nd);
    const epi = (d < EPI || nd < EPI) ? Math.min(len, EPI * 2) : 0;
    w *= Math.exp(-(o.muaHb * cp.total + o.muaT * len + o.muaM * melanin * epi));
    if (exits) return atSensor(nx) ? { weight: w, fate: 'detected' } : { weight: 0, fate: 'escaped' };
    x = nx; d = nd;
    if (w < 0.02) { if (rand() < 0.1) w *= 10; else return { weight: 0, fate: 'absorbed' }; }
    th = scatter(th, rand);
  }
  return { weight: 0, fate: 'absorbed' };
}

// Fraction of the LED's light that reaches the photodiodes for a given pulse level (0..1),
// averaged over n packets. Uses a fixed arrangement of cells for that pulse level.
const fixedBlood = new Blood(3), layoutCache = new Map();
export function layoutFor(pulse) {
  const key = Math.round(pulse * 1000);
  if (!layoutCache.has(key)) layoutCache.set(key, fixedBlood.layout(pulse));
  return layoutCache.get(key);
}
export function detectedFraction(led, pulse, melanin, n, rand = Math.random) {
  const L = layoutFor(pulse);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += tracePhoton(led, L, melanin, rand).weight;
  return sum / n;
}
