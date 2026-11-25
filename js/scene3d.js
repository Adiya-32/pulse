// scene3d.js — a low-poly 3D wrist and watch, driven live by the simulation.
// Three.js (an open-source WebGL library) only draws; every number that moves the picture
// comes from sim.js (heartbeat, arm motion, strap fit, skin tone, LED colour) and from the
// light simulation in photons.js.
// jsDelivr's "+esm" builds: the addon imports three from the same URL, so there is one copy,
// and no import map is needed (older iPhones don't support import maps).
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
import { RoundedBoxGeometry } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/geometries/RoundedBoxGeometry.js/+esm';
import {
  HALF_W, LEDS, SENSORS, EPI, DERMIS, FAT, ARTERIOLES, VEIN, VESSELS, CELL_R,
  arterioleCentre, radiusAt, Blood, layoutFor, startPhoton, step, tracePhoton, traceVisible,
} from './photons.js?v=3';
import { LED } from './sim.js?v=3';

const R = 1.75;               // wrist radius
const WX = 2.2;               // where the watch sits along the arm
const ELBOW = -8, HAND = 5.0;
const WATCH_Y = R + 0.29;     // centre of the watch body
const LEVELS = 6;             // blood levels the "light at the sensors" table is computed for
const TABLE_N = 8000;         // packets per level in that table
const TABLE_PER_FRAME = 400;
const TALLY_PER_S = 2500;     // packets per second for the live percentages
const DOTS_PER_S = 7;         // packets per second actually drawn, slow enough to follow
const DOT_SPEED = 0.45;
const TRAIL = 22;
const MAX_DOTS = 60;
const WAVE_SPEED = 4.5;       // pulse wave speed along the arm, scene units per second (slowed so you can see it travel)
const TENDONS = [[1.0, -0.45, 0.12], [1.08, 0.08, 0.12], [0.96, 0.58, 0.11]];
const BONES = [[0.1, -0.4, 0.45], [0.05, 0.5, 0.36]];
const VEINS3D = [[1.22, -0.95, 0.1], [1.25, 0.85, 0.09]];
const NO_CUT = 3;             // cut plane position when nothing should be cut away

const VIEWS = {
  outside: { pos: [WX + 4.2, 5.0, 6.6], look: [WX - 0.4, 1.3, 0], skin: 1, tag: 'Live · outside',
    caption: 'The watch flashes its green LEDs many times a second and measures how much light comes back out of your skin. Drag to look around.' },
  sensors: { pos: [WX + 1.9, 7.3, 3.4], look: [WX, 4.1, 0], skin: 1, tag: 'Live · the back of the watch',
    caption: 'The back of the watch: green LEDs shine into the skin, and photodiodes (light sensors) next to them measure how much light comes back.' },
  inside: { pos: [WX - 0.4, 5.4, 6.2], look: [WX - 2.2, 0.2, 0], skin: 0.12, tag: 'Live · inside the wrist',
    caption: 'Inside the wrist. With every heartbeat a pulse wave (the bright ring) runs down the artery, the red blood cells surge forward, and the tiny arteries under the watch fill with extra blood. Veins (blue) carry blood back at a steady pressure: no pulse.' },
  light: { pos: [WX, R - 0.33, 2], look: [WX, R - 0.33, 0], skin: 1, cut: 0, tag: 'Live · light in the skin',
    caption: 'A side cut through the skin under the watch (not to scale). The vessels are full of red blood cells, and it is the haemoglobin inside them that swallows light. Each green dot is light from an LED; follow one. If it passes through a red blood cell it is usually swallowed (the cell flashes). With every heartbeat the tiny arteries widen and fill with more cells, so more light is swallowed and less reaches the photodiodes. The vein holds cells too, but it doesn’t widen, so it adds no rhythm.' },
};

// Real absorption by oxygenated haemoglobin (molar extinction, cm⁻¹/M, Prahl's tables).
const HBO2 = { green: 39956, red: 319.6, ir: 1214 };
const FATES = [
  ['blood', 'Swallowed by haemoglobin in red blood cells (tiny arteries)', 'ring-red'],
  ['vein', 'Swallowed by red blood cells in the vein', 'ring-blue'],
  ['tissue', 'Absorbed by skin and tissue', 'ring-grey'],
  ['escaped', 'Leaves the skin elsewhere', 'fade'],
  ['detected', 'Back at a photodiode', 'star'],
];

const ease = (dt, rate) => 1 - Math.exp(-dt * rate);
function hash(x, y, z) { const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return s - Math.floor(s); }
function radialTexture(stops, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), h = size / 2, gr = g.createRadialGradient(h, h, 0, h, h, h);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function ringTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineWidth = 12; g.beginPath(); g.arc(64, 64, 44, 0, 7); g.stroke();
  g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(64, 64, 30, 0, 7); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const skinRGB = (m) => [243 + (74 - 243) * m, 205 + (44 - 205) * m, 178 + (30 - 178) * m];

export class PulseScene {
  constructor(root, { onView } = {}) {
    this.root = root; this.onView = onView || (() => {});
    this.view = 'outside';
    this.orbit = { yaw: 0, pitch: 0 }; this.last = performance.now();
    this.visible = true;
    this.dots = []; this.bursts = []; this.dotDebt = 0;
    this.meter = { t: 0 }; this.table = null;
    this.hist = { blood: [], light: [] };
    this.tally = Object.fromEntries(FATES.map(([k]) => [k, 0]));
    this.pHist = [];                // recent (time, pulse) pairs, for the travelling pulse wave
    this.blood = new Blood();       // the red blood cells in the cut
    this.layout = null; this.cellFlash = new Map();
    this.banana = { nx: 240, nd: 56, depth: 1.4, g: new Float32Array(240 * 56) };
    this.bananaCanvas = document.createElement('canvas'); this.bananaCanvas.width = 240; this.bananaCanvas.height = 56;
    this.bananaCtx = this.bananaCanvas.getContext('2d');
    this.arrivals = []; this.sideFlash = [0, 0];
    this.sensorFlash = 0; this.screenKey = ''; this.prevPulse = 0;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.localClippingEnabled = true;
    r.domElement.className = 'scene-canvas';
    root.prepend(r.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.camPos = new THREE.Vector3(...VIEWS.outside.pos);
    this.camLook = new THREE.Vector3(...VIEWS.outside.look);
    // The "Light in skin" view cuts a window out of the front of the arm (z > cut, within
    // 3 units of the watch). clipIntersection: only what is on the cut side of all three goes.
    this.cutZ = new THREE.Plane(new THREE.Vector3(0, 0, -1), NO_CUT);
    this.clip = [this.cutZ, new THREE.Plane(new THREE.Vector3(-1, 0, 0), WX - HALF_W), new THREE.Plane(new THREE.Vector3(1, 0, 0), -(WX + HALF_W))];
    this.clipOpts = { clippingPlanes: this.clip, clipIntersection: true };

    this.scene.add(new THREE.HemisphereLight(0xc8d6ff, 0x2a1830, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(6, 10, 8); this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0xff7aa8, 0.7); rim.position.set(-8, 3, -6); this.scene.add(rim);

    this.buildBackground();
    this.buildArm();
    this.buildWatch();
    this.buildInside();
    this.buildCut();
    this.buildDots();
    this.buildOverlay();

    new ResizeObserver(() => this.resize()).observe(root);
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; }).observe(root);
    this.resize();
    this.setView('outside');
  }

  // ------------------------------------------------------------------ building
  buildBackground() {
    const n = 46, pos = new Float32Array(n * 3);
    this.bgSeeds = [];
    for (let i = 0; i < n; i++) {
      pos.set([-12 + 26 * Math.random(), -4 + 13 * Math.random(), -16 + 9 * Math.random()], i * 3);
      this.bgSeeds.push(Math.random() * 6.28);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.bgBase = pos.slice();
    this.bg = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.9, map: radialTexture([[0, 'rgba(255,140,190,.9)'], [0.55, 'rgba(255,110,170,.35)'], [1, 'rgba(255,90,160,0)']]),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(this.bg);
  }

  buildArm() {
    this.arm = new THREE.Group(); this.arm.position.x = ELBOW; this.scene.add(this.arm);
    this.body = new THREE.Group(); this.body.position.x = -ELBOW; this.arm.add(this.body); // body coords: x along the arm
    this.skinMat = new THREE.MeshStandardMaterial({ color: 0xe9b48f, flatShading: true, roughness: 0.85, side: THREE.DoubleSide, ...this.clipOpts });
    const fore = new THREE.CylinderGeometry(R, 2.1, -ELBOW, 11, 4);
    const p = fore.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (y > -ELBOW / 2 - 1e-3) continue;                 // keep the wrist end exactly round
      const k = 1 + 0.06 * (hash(Math.round(x * 50), Math.round(y * 50), Math.round(z * 50)) - 0.5);
      p.setXYZ(i, x * k, y, z * k);
    }
    fore.rotateZ(-Math.PI / 2); fore.translate(ELBOW / 2, 0, 0);
    this.body.add(new THREE.Mesh(fore, this.skinMat));
    const wrist = new THREE.CylinderGeometry(R, R, 4.2, 16, 2);
    wrist.rotateZ(-Math.PI / 2); wrist.translate(2.1, 0, 0);
    this.body.add(new THREE.Mesh(wrist, this.skinMat));
    const fist = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), this.skinMat);
    fist.scale.set(1.35, 1.2, 1.5); fist.position.set(HAND, 0.05, 0); this.body.add(fist);
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.9, 2, 6), this.skinMat);
    thumb.rotation.z = Math.PI / 2; thumb.rotation.y = 0.35; thumb.position.set(HAND - 0.2, 0.55, 1.3); this.body.add(thumb);
  }

  buildWatch() {
    // the pivot sits at the centre of the watch body, so the watch can lift and turn over
    this.pivot = new THREE.Group(); this.pivot.position.set(WX, WATCH_Y, 0); this.body.add(this.pivot);
    const w = (this.watch = new THREE.Group()); w.position.y = -WATCH_Y; this.pivot.add(w);
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1f2c, roughness: 0.35, metalness: 0.4, side: THREE.DoubleSide, ...this.clipOpts });
    const box = new THREE.Mesh(new RoundedBoxGeometry(1.8, 0.55, 2.3, 3, 0.2), dark);
    box.position.y = WATCH_Y; w.add(box);
    // the cut face of the watch in the "Light in skin" view: rounded case, glass on top, and the
    // sensor window underneath with its LEDs and photodiodes (drawn in drawWatchCap)
    this.capCanvas = document.createElement('canvas'); this.capCanvas.width = 900; this.capCanvas.height = 275;
    this.capTex = new THREE.CanvasTexture(this.capCanvas); this.capTex.colorSpace = THREE.SRGBColorSpace;
    this.watchCap = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.55), new THREE.MeshBasicMaterial({ map: this.capTex, transparent: true }));
    this.watchCap.position.set(0, WATCH_Y, 0.004); w.add(this.watchCap);
    this.drawWatchCap('#21c46b');
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.2, 8), new THREE.MeshStandardMaterial({ color: 0x7d8cc4, ...this.clipOpts }));
    crown.rotation.z = Math.PI / 2; crown.position.set(0.98, R + 0.33, -0.55); w.add(crown);
    this.screenCanvas = document.createElement('canvas'); this.screenCanvas.width = 256; this.screenCanvas.height = 332;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas); this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.95), new THREE.MeshBasicMaterial({ map: this.screenTex, ...this.clipOpts }));
    screen.rotation.x = -Math.PI / 2; screen.position.y = R + 0.572; w.add(screen);
    // the back: a sensor window with green LEDs and photodiodes, at the positions photons.js uses
    const back = new THREE.Mesh(new THREE.CircleGeometry(0.78, 40), new THREE.MeshStandardMaterial({ color: 0x0f1320, roughness: 0.3, metalness: 0.2, side: THREE.DoubleSide, ...this.clipOpts }));
    back.rotation.x = Math.PI / 2; back.position.y = R + 0.012; w.add(back);
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0x21c46b, ...this.clipOpts });
    for (const [x, z] of [[LEDS[0], 0], [LEDS[1], 0], [0, -0.16], [0, 0.16]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.13), this.ledMat);
      m.position.set(x, R + 0.006, z); w.add(m);
    }
    this.sensorMat = new THREE.MeshStandardMaterial({ color: 0x39425c, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.25, metalness: 0.3, ...this.clipOpts });
    for (const [x, z] of [[SENSORS[0], 0], [SENSORS[1], 0], [0, -0.52], [0, 0.52]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.22), this.sensorMat);
      m.position.set(x, R + 0.006, z); w.add(m);
    }
    this.ledLight = new THREE.PointLight(0x21c46b, 4, 3.2, 1.6); this.ledLight.position.y = R + 0.06; w.add(this.ledLight);
    // the strap stays on the arm
    this.strap = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.07, R + 0.07, 1.4, 22, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x4f6ed8, flatShading: true, roughness: 0.7, side: THREE.DoubleSide, ...this.clipOpts }));
    this.strap.rotation.z = Math.PI / 2; this.strap.position.x = WX; this.body.add(this.strap);
    // glow on the skin around the watch
    const shell = new THREE.CylinderGeometry(R + 0.018, R + 0.018, 3.9, 40, 1, true, Math.PI / 2 - 1.3, 2.6);
    shell.rotateZ(Math.PI / 2);
    this.glowMat = new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.55, 'rgba(255,255,255,.7)'], [1, 'rgba(255,255,255,0)']]),
      color: 0x21c46b, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...this.clipOpts });
    this.glow = new THREE.Mesh(shell, this.glowMat); this.glow.position.x = WX; this.body.add(this.glow);
  }

  // A side view of the watch as if cut in half, matching the case size (1.8 × 0.55, corner 0.2)
  // and the LED and photodiode positions the light simulation uses.
  drawWatchCap(ledHex) {
    this.capLed = ledHex;
    const c = this.capCanvas.getContext('2d'), W = 900, H = 275, S = 500;   // 500 px per scene unit
    const X = (x) => (x + 0.9) * S;
    c.clearRect(0, 0, W, H);
    const rr = (x, y, w, h, r) => {          // rounded rectangle (ctx.roundRect is missing on older phones)
      r = Math.min(r, w / 2, h / 2);
      c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    };
    // case
    rr(0, 0, W, H, 100);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#323b55'); g.addColorStop(0.25, '#1b2030'); g.addColorStop(1, '#0c0f18');
    c.fillStyle = g; c.fill();
    c.lineWidth = 6; c.strokeStyle = 'rgba(160,175,220,.35)'; c.stroke();
    // glass and screen on top
    rr(40, 8, W - 80, 26, 13); c.fillStyle = '#4a5680'; c.fill();
    rr(60, 12, W - 120, 7, 4); c.fillStyle = 'rgba(255,255,255,.45)'; c.fill();
    rr(70, 36, W - 140, 14, 7); c.fillStyle = '#05070c'; c.fill();
    // inside: a battery and a circuit board, faintly
    rr(150, 70, W - 300, 70, 14); c.fillStyle = 'rgba(120,135,180,.12)'; c.fill();
    rr(180, 160, W - 360, 30, 8); c.fillStyle = 'rgba(80,200,140,.08)'; c.fill();
    // sensor window on the back
    const bw = 0.78 * S;
    rr(X(0) - bw, H - 30, 2 * bw, 30, 10); c.fillStyle = '#05070c'; c.fill();
    // photodiodes
    for (const x of SENSORS) {
      rr(X(x) - 55, H - 26, 110, 22, 5); c.fillStyle = '#3a4566'; c.fill();
      rr(X(x) - 40, H - 22, 80, 7, 3); c.fillStyle = 'rgba(190,205,255,.55)'; c.fill();
    }
    // LEDs, glowing
    c.save(); c.shadowColor = ledHex; c.shadowBlur = 30;
    for (const x of LEDS) { rr(X(x) - 32, H - 24, 64, 20, 5); c.fillStyle = ledHex; c.fill(); }
    c.restore();
    this.capTex.needsUpdate = true;
  }

  buildInside() {
    const g = (this.inside = new THREE.Group()); this.body.add(g);
    const tube = (pts, r, mat, segs = 60) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs, r, 7), mat);
    const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.6, ...extra });
    const along = (wob) => Array.from({ length: 9 }, (_, i) => new THREE.Vector3(ELBOW + 0.6 + i * (4.4 - ELBOW - 0.6) / 8, wob * Math.sin(i * 1.7), wob * Math.cos(i * 2.3)));
    this.ART3D = [[-0.15, -0.95, 0.2], [-0.3, 0.95, 0.18]];
    this.arteries = this.ART3D.map(([y, z, r]) => {
      const m = tube(along(0.05), r, mat(0xd8283a, { emissive: 0x5a0010, emissiveIntensity: 0.6, transparent: true, opacity: 0.55 }));
      m.position.set(0, y, z); g.add(m); return m;
    });
    VEINS3D.forEach(([y, z, r]) => { const m = tube(along(0.06), r, mat(0x4d63e0, { emissive: 0x101a60, transparent: true, opacity: 0.8 })); m.position.set(0, y, z); g.add(m); });
    TENDONS.forEach(([y, z, r]) => { const m = tube(along(0.03), r, mat(0xb9c2cc, { transparent: true, opacity: 0.5 })); m.position.set(0, y, z); g.add(m); });
    BONES.forEach(([y, z, r]) => { const m = tube(along(0.02), r, mat(0xcfc4ad, { transparent: true, opacity: 0.45 })); m.position.set(0, y, z); g.add(m); });
    // tiny arteries and capillaries in the top layer of skin, under and around the watch
    this.capMat = mat(0xff4d63, { emissive: 0xff2040, emissiveIntensity: 0.3, transparent: true, opacity: 0.8 });
    for (let i = 0; i < 60; i++) {
      const x0 = WX - 2 + 4 * Math.random(), a0 = Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const d = 0.12 + 0.3 * Math.random();
      const pts = [];
      for (let k = 0; k < 5; k++) {
        const a = a0 + (k - 2) * 0.09, rr = R - d + 0.06 * Math.sin(k * 1.3 + i);
        pts.push(new THREE.Vector3(x0 + (k - 2) * 0.12 + 0.05 * Math.sin(i + k), Math.sin(a) * rr, Math.cos(a) * rr));
      }
      g.add(tube(pts, 0.026, this.capMat, 10));
    }
    const N = 160;
    this.cells = new THREE.InstancedMesh(new THREE.TorusGeometry(0.1, 0.05, 5, 10), mat(0xff3b55, { emissive: 0x7a0018 }), N);
    this.cellState = Array.from({ length: N }, (_, i) => ({
      a: i % 2, x: ELBOW + 0.8 + Math.random() * (4.2 - ELBOW - 0.8),
      rr: Math.sqrt(Math.random()) * 0.6, th: Math.random() * 6.28,
      rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, 0), spin: (Math.random() - 0.5) * 3,
    }));
    g.add(this.cells);
    this.waves = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 6, 24), new THREE.MeshBasicMaterial({ color: 0xffb3c0, transparent: true, opacity: 0, depthWrite: false }));
      m.rotation.y = Math.PI / 2; m.visible = false; g.add(m);
      this.waves.push({ m, x: 0, a: 0, live: false });
    }
    this.tmp = new THREE.Object3D();
  }

  // The cut face for "Light in skin": a flat plane at z = 0, drawn from the same layers, vessels
  // and red blood cells the light simulation uses (photons.js): what you see is what light meets.
  buildCut() {
    this.cutW = 2048; this.cutH = Math.round(2048 * (2 * R) / (2 * HALF_W));
    this.cutCanvas = document.createElement('canvas'); this.cutCanvas.width = this.cutW; this.cutCanvas.height = this.cutH;
    this.cutTex = new THREE.CanvasTexture(this.cutCanvas); this.cutTex.colorSpace = THREE.SRGBColorSpace; this.cutTex.anisotropy = 8;
    this.cutFace = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF_W, 2 * R), new THREE.MeshBasicMaterial({ map: this.cutTex }));
    this.cutFace.position.set(WX, 0, 0.002); this.body.add(this.cutFace);
  }

  drawCut(q, melanin) {
    const c = this.cutCanvas.getContext('2d'), W = this.cutW, H = this.cutH, S = W / (2 * HALF_W);
    const X = (x) => (x + HALF_W) * S, D = (d) => d * S;
    const band = (d0, d1, col) => { c.fillStyle = col; c.fillRect(0, D(d0), W, D(d1) - D(d0)); };
    band(0, H / S, '#2e1d33');                                 // muscle and everything deeper
    band(EPI, DERMIS, '#3a2238');                              // dermis
    band(DERMIS, FAT, '#55433a');                              // fat
    const sk = skinRGB(melanin).map((v) => Math.round(v * 0.85));
    band(0, EPI, `rgb(${sk})`);                                // epidermis with melanin
    // vessel walls and the plasma inside, following the pulse wave along x
    VESSELS.forEach((v) => {
      const n = 160, top = [], bot = [];
      for (let i = 0; i <= n; i++) {
        const x = -HALF_W + (2 * HALF_W * i) / n, cy = v.centre(x), r = radiusAt(v, q(x)) + CELL_R * 0.4;
        top.push([X(x), D(cy - r)]); bot.push([X(x), D(cy + r)]);
      }
      c.beginPath(); top.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      for (let i = bot.length - 1; i >= 0; i--) c.lineTo(...bot[i]);
      c.closePath();
      c.fillStyle = v.kind === 'vein' ? '#2a2c66' : '#7a2d4c'; c.fill();
      c.lineWidth = 5; c.strokeStyle = v.kind === 'vein' ? '#6b74e6' : '#f07a95'; c.stroke();
      // the pulse wave: where it is passing right now, the artery wall lights up
      if (v.swell > 0) {
        c.lineWidth = 9; c.lineCap = 'round';
        for (let i = 0; i < n; i++) {
          const qq = q(-HALF_W + (2 * HALF_W * (i + 0.5)) / n);
          if (qq < 0.25) continue;
          c.strokeStyle = `rgba(255,215,225,${Math.min(1, (qq - 0.25) * 1.4).toFixed(2)})`;
          for (const edge of [top, bot]) { c.beginPath(); c.moveTo(...edge[i]); c.lineTo(...edge[i + 1]); c.stroke(); }
        }
      }
    });
    // red blood cells: a red disc with a paler dimple (they're biconcave). Arterial blood is rich
    // in oxygen and bright scarlet; venous blood has given up oxygen and is dark burgundy. A cell that has just swallowed a photon flashes.
    const L = this.layout, rr = CELL_R * S;
    for (let i = 0; i < L.x.length; i++) {
      const x = X(L.x[i]), y = D(L.d[i]), vein = VESSELS[L.v[i]].kind === 'vein';
      const sq = 0.65 + 0.35 * L.tilt[i];                      // cells seen at different angles
      c.beginPath(); c.ellipse(x, y, rr, rr * sq, L.tilt[i] * 3, 0, 7);
      c.fillStyle = vein ? '#6a1442' : '#ff2e4d'; c.fill();
      c.beginPath(); c.ellipse(x, y, rr * 0.45, rr * 0.45 * sq, L.tilt[i] * 3, 0, 7);
      c.fillStyle = vein ? '#8a2c64' : '#ff8fa0'; c.fill();
    }
    for (const [id, t] of this.cellFlash) {
      const i = L.byId.get(id); if (i === undefined) continue;
      const x = X(L.x[i]), y = D(L.d[i]), a = t / 0.8;
      c.beginPath(); c.arc(x, y, rr * (1.4 + 1.6 * (1 - a)), 0, 7);
      c.strokeStyle = `rgba(255,255,255,${a})`; c.lineWidth = 4; c.stroke();
      c.beginPath(); c.arc(x, y, rr * 1.1, 0, 7); c.fillStyle = `rgba(255,240,200,${0.8 * a})`; c.fill();
    }
    // drawn over the cells so it stays visible.
    // the "banana": where the light that reached a photodiode actually travelled, built up from
    // the simulated paths (not drawn by hand)
    if (this.banana) {
      const B = this.banana, img = this.bananaCtx.createImageData(B.nx, B.nd);
      let max = 1e-9; for (let i = 0; i < B.g.length; i++) if (B.g[i] > max) max = B.g[i];
      const col = this.bananaColor || [33, 196, 107];
      for (let i = 0; i < B.g.length; i++) {
        const a = Math.pow(Math.min(1, B.g[i] / (max * 0.45)), 0.55);
        img.data.set([col[0], col[1], col[2], Math.round(175 * a)], i * 4);
      }
      this.bananaCtx.putImageData(img, 0, 0);
      c.save(); c.globalCompositeOperation = 'lighter'; c.imageSmoothingEnabled = true;
      c.drawImage(this.bananaCanvas, 0, 0, W, D(B.depth)); c.restore();
    }
    this.cutTex.needsUpdate = true;
  }

  buildDots() {
    const dot = radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,.85)'], [1, 'rgba(255,255,255,0)']]);
    const mkPoints = (n, size, map) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
      const p = new THREE.Points(g, new THREE.PointsMaterial({ size, map, vertexColors: true, transparent: true, depthTest: false, depthWrite: false }));
      p.renderOrder = 12; p.frustumCulled = false; return p;    // positions change every frame
    };
    this.heads = mkPoints(MAX_DOTS, 0.17, dot);
    this.burstPts = mkPoints(80, 0.28, ringTexture());
    this.trails = mkPoints(MAX_DOTS * TRAIL * 3, 0.06, dot);
    this.trails.renderOrder = 11;
    // dot coordinates: (x along the cut, −depth); the layer sits on the skin surface at z = 0
    this.dotLayer = new THREE.Group(); this.dotLayer.position.set(WX, R, 0.012);
    // a glow on each photodiode when light reaches it
    this.sensorGlow = mkPoints(2, 0.42, dot);
    this.sensorGlow.geometry.attributes.position.array.set([SENSORS[0], 0.01, 0, SENSORS[1], 0.01, 0]);
    this.dotLayer.add(this.trails, this.heads, this.burstPts, this.sensorGlow); this.body.add(this.dotLayer);
  }

  buildOverlay() {
    const q = (s) => this.root.querySelector(s);
    this.tagEl = q('.scene-tag span'); this.captionEl = document.getElementById('sceneCaption');
    this.beatCue = q('.beat-cue');
    this.labelBox = q('.scene-labels'); this.card = document.querySelector('.story-card');
    this.root.querySelectorAll('.scene-views button').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view)));
    const mk = (text, pos, views, cls = '', obj = this.body) => {
      const el = document.createElement('div'); el.className = `tag3d ${cls}`; el.innerHTML = `<i></i><span>${text}</span>`; el.style.opacity = 0;
      this.labelBox.appendChild(el); return { el, pos: new THREE.Vector3(...pos), views, obj, span: el.querySelector('span') };
    };
    const lx = -1.1;    // x (along the cut) for the layer labels
    this.labels = [
      mk('Green LEDs', [WX - 0.2, R * 0.93, -1.15], ['outside']),
      mk('green LEDs', [LEDS[1], R, 0], ['sensors'], '', this.watch),
      mk('photodiodes (light sensors)', [0, R, -0.52], ['sensors'], 'below', this.watch),
      mk('artery', [WX - 5.6, -0.35, -0.95], ['inside'], 'below'),
      mk('tiny arteries + capillaries', [WX - 0.9, R - 0.12, 0.95], ['inside']),
      mk('vein: steady flow, no pulse', [WX - 3.6, VEINS3D[1][0], VEINS3D[1][1]], ['inside']),
      mk('green LED', [LEDS[1], R, 0], ['light'], '', this.watch),
      mk('photodiode', [SENSORS[0], R, 0], ['light'], '', this.watch),
      mk('skin + pigment', [WX + lx - 0.1, R - EPI / 2, 0], ['light']),
      mk('tiny artery: widens with each beat', [WX + lx + 0.05, R - arterioleCentre(ARTERIOLES[2], lx + 0.05) - ARTERIOLES[2].r, 0], ['light'], 'below'),
      mk('vein: doesn’t widen', [WX + 1.0, R - VEIN.d - VEIN.r, 0], ['light'], 'below'),
    ];
    this.ledLabels = [this.labels[0], this.labels[1], this.labels[6]];
    this.waveLabel = mk('pulse wave of one heartbeat', [0, 0, 0], ['inside'], 'live');
    this.cellLabel = mk('red blood cells', [0, 0, 0], ['inside'], 'below');
    this.rbcLabel = mk('red blood cell: full of haemoglobin', [0, 0, 0], ['light'], 'lft');
    this.labels.push(this.waveLabel, this.cellLabel, this.rbcLabel);
    let drag = null;
    const cv = this.renderer.domElement;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: this.orbit.yaw, pitch: this.orbit.pitch }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.orbit.yaw = drag.yaw - (e.clientX - drag.x) * 0.008;
      this.orbit.pitch = Math.max(-0.6, Math.min(0.7, drag.pitch + (e.clientY - drag.y) * 0.006));
    });
    const end = () => { drag = null; }; cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  }

  fillCard(v) {
    const c = this.card, rows = c.querySelector('.story-rows'), title = c.querySelector('.story-title'), note = c.querySelector('.story-note');
    c.querySelector('.graphs').hidden = v === 'outside' || v === 'sensors';
    c.querySelector('.g-light-wrap').hidden = v !== 'light';
    c.querySelector('.duo').hidden = v !== 'light';
    const row = (sw, text, k) => `<div class="srow"><i class="sw ${sw}"></i><span>${text}</span>${k ? `<b data-k="${k}">–</b>` : '<b></b>'}</div>`;
    if (v === 'outside') {
      title.textContent = 'What you’re looking at';
      rows.innerHTML = row('star', 'Green glow: LEDs on the back shining into your skin') + row('rbc', 'Screen: the pulse the watch worked out from the light');
      note.textContent = 'Try the sliders below: arm movement, strap fit, LED colour. Then press “Sensors”.';
    } else if (v === 'sensors') {
      title.textContent = 'The back of the watch';
      rows.innerHTML = row('star', 'Green LEDs: shine light into the skin') + row('still', 'Photodiodes: measure how much light comes back');
      note.textContent = 'The LEDs run at very low power (a few milliwatts) and flash only briefly, many times a second: safe for skin, and the change they measure is far too small for your eye to see.';
    } else if (v === 'inside') {
      title.textContent = 'What’s moving';
      rows.innerHTML = row('ring-pink', 'Bright ring: the pulse wave of one heartbeat') + row('rbc', 'Red blood cells: surge forward on each beat')
        + row('cap', 'Tiny arteries under the watch: fill with blood and glow') + row('vein', 'Veins: blood flows back steadily, no pulse') + row('still', 'Tendons and bone: don’t move');
      note.textContent = 'The watch only sees the top layer. The extra blood there on each beat is the signal. Next: “Light in skin”.';
    } else {
      title.textContent = 'What happens to the light';
      rows.innerHTML = FATES.map(([k, text, sw]) => row(sw, text, k)).join('')
        + row('banana', 'Soft glow: the paths of light that reached a photodiode. They bend down into the vessels and back up: the “banana”');
    }
  }

  setView(v) {
    this.view = v; this.orbit.yaw = 0; this.orbit.pitch = 0; this.viewSince = performance.now();
    this.root.querySelectorAll('.scene-views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    this.tagEl.textContent = VIEWS[v].tag;
    if (this.captionEl) this.captionEl.textContent = VIEWS[v].caption;
    this.fillCard(v);
    this.dots.length = 0; this.bursts.length = 0;
    this.hist.blood.length = 0; this.hist.light.length = 0;
    for (const k in this.tally) this.tally[k] = 0;
    this.onView(v);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.root;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.9 ? 50 : 38;
    this.camera.updateProjectionMatrix();
  }

  // pulse at position x along the cut (x = 0 under the watch): the wave comes from the elbow
  // side, so it reaches points further along the arm a little later
  pulseAt(now) {
    const H = this.pHist;
    return (x) => {
      const t = now - ((x + HALF_W) / WAVE_SPEED) * 1000;     // arrives from the elbow side (−x) first
      for (let i = H.length - 1; i > 0; i--) if (H[i - 1][0] <= t) return H[i - 1][1];
      return H.length ? H[0][1] : 0;
    };
  }

  // ------------------------------------------------------------------ per frame
  update(now, s, params, readout) {
    const real = Math.max(0, (now - this.last) / 1000); this.last = now;
    const dt = Math.min(0.1, real);       // for motion and simulation steps
    const de = Math.min(0.5, real);       // for camera and cut-away easing: keeps up even at low frame rates
    if (!s) return;
    this.nowMs = now;
    this.pHist.push([now, s.pulse]); while (this.pHist.length > 2 && this.pHist[0][0] < now - 2500) this.pHist.shift();
    if (!this.visible || document.hidden) return;
    const V = VIEWS[this.view], led = LED[params.led];
    const ledColor = new THREE.Color(led.color);

    // camera: glide to the chosen view, plus whatever the user dragged
    const k = ease(de, 3);
    const target = new THREE.Vector3(...V.pos), look = new THREE.Vector3(...V.look);
    if (this.view === 'light') {        // step back until the whole region around the watch fits
      const halfW = Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect;
      target.z = Math.max(V.pos[2], (this.camera.aspect < 0.9 ? 0.85 : 1.35) / halfW);   // phones: just the LEDs and photodiodes
    }
    const off = target.clone().sub(look);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta += this.orbit.yaw; sph.phi = Math.min(Math.PI - 0.2, Math.max(0.2, sph.phi - this.orbit.pitch));
    target.copy(look).add(new THREE.Vector3().setFromSpherical(sph));
    this.camPos.lerp(target, k); this.camLook.lerp(look, k);
    this.camera.position.copy(this.camPos); this.camera.lookAt(this.camLook);

    // cut-away, see-through skin
    const cutTo = V.cut ?? NO_CUT;
    this.cutZ.constant += (cutTo - this.cutZ.constant) * ease(de, 2.6);
    if (Math.abs(this.cutZ.constant - cutTo) < 0.01) this.cutZ.constant = cutTo;
    const cutOpen = this.cutZ.constant < 0.03;
    this.cutFace.visible = cutOpen; this.watchCap.visible = cutOpen; this.dotLayer.visible = cutOpen;
    const op = this.skinMat.opacity + (V.skin - this.skinMat.opacity) * ease(de, 4);
    this.skinMat.opacity = op; this.skinMat.transparent = op < 0.99; this.skinMat.depthWrite = op >= 0.99;
    this.inside.visible = op < 0.97;
    this.glow.visible = this.view === 'outside' || this.view === 'inside';
    this.skinMat.color.setRGB(...skinRGB(params.melanin).map((v) => v / 255)).convertSRGBToLinear();

    // the arm moves as the simulated wrist does; a loose strap lets the watch lift;
    // in "Sensors" the watch lifts right off and turns over to show its back
    this.arm.rotation.z = 0.07 * s.motion; this.arm.rotation.x = 0.04 * s.motion;
    const gap = (1 - params.fit) * 0.32 + Math.abs(s.motion) * 0.1 * (0.3 + (1 - params.fit));
    const flip = this.view === 'sensors';
    this.pivot.position.y += (WATCH_Y + gap + (flip ? 2.0 : 0) - this.pivot.position.y) * ease(de, flip ? 3 : 8);
    this.pivot.rotation.x += ((flip ? -Math.PI * 0.74 : 0) - this.pivot.rotation.x) * ease(de, 3);   // back turns towards the camera

    // heartbeat
    const pulse = s.pulse, q = this.pulseAt(now);
    const rising = pulse > 0.5 && this.prevPulse <= 0.5; this.prevPulse = pulse;
    if (this.inside.visible) this.updateInside(dt, pulse, rising);
    this.beatCue.style.opacity = this.view === 'inside' || this.view === 'light' ? Math.min(1, (this.view === 'light' ? q(0) : pulse) * 1.3).toFixed(2) : 0;

    // LED glow: dims a little with each beat (more blood, more light absorbed) and with darker skin
    const dip = { green: 0.3, red: 0.04, ir: 0.05 }[params.led];
    const skinT = Math.exp(-led.melanin * params.melanin * 1.5);
    this.glowMat.color.copy(ledColor);
    this.glowMat.opacity = skinT * (1 - dip * pulse) * (1 - 0.5 * gap);
    this.ledLight.color.copy(ledColor); this.ledLight.intensity = this.view === 'sensors' ? 0 : 12 * skinT * (1 - dip * pulse);
    this.ledMat.color.copy(ledColor);
    if (this.capLed !== led.color) this.drawWatchCap(led.color);
    for (const L of this.ledLabels) L.span.textContent = `${led.name} LED${L === this.labels[6] ? '' : 's'}`;

    const pop = Math.max(0, 1 - (now - (readout.beatAt || -1e9)) / 220);
    const key = `${readout.bpm}|${pop.toFixed(1)}`;
    if (key !== this.screenKey) { this.screenKey = key; this.drawScreen(readout.bpm, pop); }

    if (this.view === 'light' && cutOpen) {
      this.stepLight(dt, params, q, ledColor);
      this.drawCut(q, params.melanin);
    } else {
      this.heads.geometry.setDrawRange(0, 0); this.trails.geometry.setDrawRange(0, 0); this.burstPts.geometry.setDrawRange(0, 0);
    }
    // graphs in the card (15 samples a second)
    this.meter.t += dt;
    if (this.meter.t >= 1 / 15) {
      this.meter.t = 0;
      const qw = q(0);
      this.hist.blood.push(qw); if (this.hist.blood.length > 75) this.hist.blood.shift();
      if (this.view === 'light' && this.table && this.table.n[LEVELS - 1] > 300) {
        const T = this.table, xx = qw * (LEVELS - 1), i = Math.min(LEVELS - 2, Math.floor(xx)), f = xx - i;
        const val = (T.sum[i] / T.n[i]) * (1 - f) + (T.sum[i + 1] / T.n[i + 1]) * f;
        this.hist.light.push(val); if (this.hist.light.length > 75) this.hist.light.shift();
        const lo = T.sum[LEVELS - 1] / T.n[LEVELS - 1], hi = T.sum[0] / T.n[0];
        this.setDuo(qw, hi > lo ? (val - lo) / (hi - lo) : 0.5);
      }
      if (this.view === 'inside' || this.view === 'light') this.drawGraphs(params, ledColor);
    }
    this.sensorFlash *= Math.exp(-dt * 6);
    this.sensorMat.emissive.copy(ledColor); this.sensorMat.emissiveIntensity = Math.min(2.5, this.sensorFlash);

    const bp = this.bg.geometry.attributes.position;
    for (let i = 0; i < bp.count; i++) bp.setY(i, this.bgBase[i * 3 + 1] + 0.35 * Math.sin(now / 2600 + this.bgSeeds[i]));
    bp.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  // the "blood MORE / light LESS" panel
  setDuo(blood, light) {
    const d = this.card.querySelector('.duo');
    const set = (k, v) => {
      d.querySelector(`[data-bar="${k}"]`).style.width = `${Math.round(8 + 92 * Math.max(0, Math.min(1, v)))}%`;
      d.querySelector(`[data-word="${k}"]`).textContent = v > 0.5 ? 'MORE' : 'LESS';
    };
    set('blood', blood); set('light', light);
  }

  updateInside(dt, pulse, rising) {
    this.arteries.forEach((m) => { m.scale.y = m.scale.z = 1 + 0.15 * pulse; });
    this.capMat.emissiveIntensity = 0.15 + 1.6 * pulse;
    this.capMat.opacity = 0.45 + 0.55 * pulse;
    if (rising) {
      this.ART3D.forEach((_, a) => {
        const w = this.waves.find((qq) => !qq.live);
        if (w) Object.assign(w, { live: true, x: ELBOW + 0.6, a });
      });
    }
    let newest = null;
    for (const w of this.waves) {
      if (!w.live) { w.m.visible = false; continue; }
      w.x += 7 * dt;
      if (w.x > 4.3) { w.live = false; w.m.visible = false; continue; }
      const [ay, az, ar] = this.ART3D[w.a];
      w.m.visible = true; w.m.position.set(w.x, ay, az); w.m.scale.setScalar(ar * 1.55);
      w.m.material.opacity = 0.95 * Math.min(1, (4.3 - w.x) / 2);
      if (w.a === 0 && (!newest || w.x > newest.x)) newest = w;
    }
    this.waveLabel.hide = !newest || newest.x > WX - 1;
    if (newest) this.waveLabel.pos.set(newest.x, this.ART3D[0][0] + this.ART3D[0][2] * 1.5, this.ART3D[0][1]);
    const flow = 0.4 + 3.6 * pulse;
    let label = null;
    this.cellState.forEach((c, i) => {
      c.x += flow * dt * (0.8 + 0.4 * ((i * 7) % 5) / 5);
      if (c.x > 4.3) c.x = ELBOW + 0.8;
      const [ay, az, ar] = this.ART3D[c.a], rr = c.rr * ar * (1 + 0.15 * pulse);
      c.rot.x += c.spin * dt; c.rot.y += c.spin * 0.7 * dt;
      this.tmp.position.set(c.x, ay + Math.sin(c.th) * rr, az + Math.cos(c.th) * rr);
      this.tmp.rotation.copy(c.rot); this.tmp.updateMatrix();
      this.cells.setMatrixAt(i, this.tmp.matrix);
      if (c.a === 1 && c.x > WX - 3.2 && c.x < WX - 2.2 && !label) label = this.tmp.position.clone();
    });
    this.cells.instanceMatrix.needsUpdate = true;
    if (label) this.cellLabel.pos.copy(label);
  }

  stepLight(dt, params, q, ledColor) {
    const led = params.led, mel = params.melanin;
    // the cells flow along their vessels; the vessels follow the pulse wave
    this.blood.advance(dt, q);
    const L = (this.layout = this.blood.layout(q));
    for (const [id, t] of this.cellFlash) { if (t - dt <= 0) this.cellFlash.delete(id); else this.cellFlash.set(id, t - dt); }
    // 1) the graph: how much light reaches the photodiodes for a given amount of blood. The
    // same Monte Carlo (low-noise "weight" method) is run for 6 blood levels, each with its own
    // arrangement of cells, and kept in a table; rebuilt when the LED colour or skin tone changes.
    const key = `${led}|${mel.toFixed(2)}`;
    if (!this.table || this.table.key !== key) this.table = { key, sum: new Float64Array(LEVELS), n: new Uint32Array(LEVELS) };
    const T = this.table;
    for (let b = 0; b < LEVELS; b++) {          // a few packets for every level each frame
      const add = Math.min(Math.ceil(TABLE_PER_FRAME / LEVELS), TABLE_N - T.n[b]), Lb = layoutFor(b / (LEVELS - 1));
      for (let i = 0; i < add; i++) T.sum[b] += tracePhoton(led, Lb, mel).weight;
      T.n[b] += add;
    }
    // 2) the percentages: what happens to light, over the last couple of seconds
    const nT = Math.min(120, Math.round(TALLY_PER_S * dt)), dec = Math.exp(-dt / 2), t = this.tally;
    for (const kk in t) t[kk] *= dec;
    const B = this.banana;
    if (B.key !== key) { B.g.fill(0); B.key = key; this.bananaColor = [ledColor.r, ledColor.g, ledColor.b].map((v) => Math.round(255 * Math.pow(v, 1 / 2.2))); }
    const bDecay = Math.exp(-dt / 8);
    for (let i = 0; i < B.g.length; i++) B.g[i] *= bDecay;
    for (let i = 0; i < nT; i++) {
      const p = traceVisible(led, L, mel);
      t[p.fate === 'absorbed' ? (p.by === 'blood' || p.by === 'vein' ? p.by : 'tissue') : p.fate]++;
      if (p.fate === 'detected') {             // add this path to the banana picture
        const P = p.path;
        for (let j = 2; j < P.length; j += 2) {
          const x0 = P[j - 2], d0 = P[j - 1], x1 = P[j], d1 = P[j + 1], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, d1 - d0) / 0.012));
          for (let k = 0; k < n; k++) {
            const x = x0 + ((x1 - x0) * k) / n, d = d0 + ((d1 - d0) * k) / n;
            const gx = Math.floor(((x + HALF_W) / (2 * HALF_W)) * B.nx), gd = Math.floor((d / B.depth) * B.nd);
            if (gx >= 0 && gx < B.nx && gd >= 0 && gd < B.nd) B.g[gd * B.nx + gx] += 1;
          }
        }
      }
    }
    // 3) the dots you can follow. Each one is simulated live, one step at a time, against the
    // cells as they are now, so a dot that is swallowed flies into the very cell that took it.
    this.dotDebt += DOTS_PER_S * dt;
    while (this.dotDebt >= 1) {
      this.dotDebt--;
      if (this.dots.length >= MAX_DOTS) break;
      const { st, pigment } = startPhoton(led, mel);
      const res = pigment ? { x: st.x, d: 0.02, fate: 'absorbed', by: 'pigment' } : step(st, led, L, mel, Math.random);
      this.dots.push({ st, pos: [st.x, 0], res, trail: [[st.x, 0]], color: ledColor.clone().lerp(new THREE.Color(0xffffff), 0.3) });
    }
    const endColor = { blood: 0xff2a4a, vein: 0x6f7bff, pigment: 0x9aa0b0, tissue: 0x9aa0b0 };
    const keep = [];
    for (const a of this.dots) {
      let budget = DOT_SPEED * dt, done = false;
      while (budget > 0 && !done) {
        if (a.res.cellId !== undefined) { const i = L.byId.get(a.res.cellId); if (i !== undefined) { a.res.x = L.x[i]; a.res.d = L.d[i]; } }
        const dx = a.res.x - a.pos[0], dd = a.res.d - a.pos[1], dist = Math.hypot(dx, dd);
        if (dist > budget) { a.pos[0] += (dx / dist) * budget; a.pos[1] += (dd / dist) * budget; budget = 0; break; }
        a.pos = [a.res.x, a.res.d]; budget -= dist;
        a.trail.push([a.res.x, a.res.d]); if (a.trail.length > TRAIL) a.trail.shift();
        const r = a.res;
        if (r.fate === 'gone') { done = true; break; }
        if (r.fate === 'escaped') { a.res = { x: r.x, d: -0.12, fate: 'gone' }; continue; }   // visibly leave the skin
        if (r.fate === 'detected') {
          this.sensorFlash = 2.5; this.sideFlash[r.x < 0 ? 0 : 1] = 1; this.arrivals.push(this.nowMs);
          this.bursts.push({ x: r.x, d: 0, col: ledColor.clone(), t: 0 }); done = true; break;
        }
        if (r.fate === 'absorbed') {
          this.bursts.push({ x: r.x, d: r.d, col: new THREE.Color(endColor[r.by]), t: 0 });
          if (r.cellId !== undefined) this.cellFlash.set(r.cellId, 0.8);
          done = true; break;
        }
        a.res = step(a.st, led, L, mel, Math.random);
      }
      if (!done) keep.push(a);
    }
    this.dots = keep;
    // draw: heads, bead trails, end bursts
    const hp = this.heads.geometry.attributes.position.array, hc = this.heads.geometry.attributes.color.array;
    const tp = this.trails.geometry.attributes.position.array, tc = this.trails.geometry.attributes.color.array;
    let h = 0, tr = 0;
    for (const a of this.dots) {
      const fade = a.res.fate === 'gone' ? Math.min(1, -a.pos[1] < 0 ? 1 : 1 - -a.pos[1] / 0.12) : 1;
      hp.set([a.pos[0], -a.pos[1], 0], h * 3); hc.set([a.color.r, a.color.g, a.color.b, fade], h * 4); h++;
      const pts = [...a.trail, a.pos];
      for (let j = pts.length - 1, n = 0; j > 0 && tr < MAX_DOTS * TRAIL * 3 - 3; j--, n++) {
        const [px, pd] = pts[j], [qx, qd] = pts[j - 1];
        for (let b = 0; b < 3; b++) {           // three beads per step, fading towards the tail
          const u = b / 3, al = 0.8 * fade * (1 - (n + u) / TRAIL);
          if (al <= 0) break;
          tp.set([px + (qx - px) * u, -(pd + (qd - pd) * u), 0], tr * 3);
          tc.set([a.color.r, a.color.g, a.color.b, al], tr * 4); tr++;
        }
      }
    }
    const sc = this.sensorGlow.geometry.attributes.color.array;
    this.sideFlash = this.sideFlash.map((f) => f * Math.exp(-dt * 4));
    sc.set([ledColor.r, ledColor.g, ledColor.b, this.sideFlash[0], ledColor.r, ledColor.g, ledColor.b, this.sideFlash[1]]);
    this.sensorGlow.geometry.setDrawRange(0, 2); this.sensorGlow.geometry.attributes.color.needsUpdate = true;
    while (this.arrivals.length && this.arrivals[0] < this.nowMs - 5000) this.arrivals.shift();
    const bp = this.burstPts.geometry.attributes.position.array, bc = this.burstPts.geometry.attributes.color.array;
    let b = 0;
    this.bursts = this.bursts.filter((u) => (u.t += dt) < 0.9);
    for (const u of this.bursts.slice(-80)) { bp.set([u.x, -u.d, 0], b * 3); bc.set([u.col.r, u.col.g, u.col.b, 1 - u.t / 0.9], b * 4); b++; }
    for (const [g, n] of [[this.heads.geometry, h], [this.burstPts.geometry, b], [this.trails.geometry, tr]]) {
      g.setDrawRange(0, n); g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true;
    }
    // a label that follows one red blood cell in the top tiny artery, near the photodiode
    let best = -1, bd = 1e9;
    for (let i = 0; i < L.x.length; i++) if (L.v[i] === 0) { const dd = Math.abs(L.x[i] - 0.95); if (dd < bd) { bd = dd; best = i; } }
    if (best >= 0) this.rbcLabel.pos.set(WX + L.x[best], R - L.d[best], 0.01);
    const tot = Object.values(t).reduce((x, y) => x + y, 0) || 1;
    this.card.querySelectorAll('.story-rows b[data-k]').forEach((el) => {
      const v = (100 * t[el.dataset.k]) / tot;
      el.textContent = v < 1 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
    });
  }

  drawGraphs(params, ledColor) {
    const draw = (cv, data, color, autoscale) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
      if (!W) return;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
      if (data.length < 2) return;
      let lo = 0, hi = 1;
      if (autoscale) { lo = Math.min(...data); hi = Math.max(...data); const pad = Math.max((hi - lo) * 0.15, hi * 0.08); lo -= pad; hi += pad; }
      c.strokeStyle = color; c.lineWidth = 2; c.lineJoin = 'round'; c.beginPath();
      data.forEach((v, i) => { const x = W - ((data.length - 1 - i) / 74) * W, y = H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
    };
    draw(this.card.querySelector('.g-blood'), this.hist.blood, '#ff4d6d', false);
    if (this.view === 'light') {
      const gl = this.card.querySelector('.g-light');
      draw(gl, this.hist.light, `#${ledColor.getHexString()}`, true);
      // a tick for every light dot that reached a photodiode, on the same time axis
      const c2 = gl.getContext('2d'), Wd = gl.clientWidth;
      c2.fillStyle = `#${ledColor.getHexString()}`;
      for (const ta of this.arrivals) { const x = Wd - ((this.nowMs - ta) / 5000) * Wd; c2.fillRect(x - 1, 0, 2, 6); }
      const mean = this.hist.light.length ? this.hist.light.reduce((a, b) => a + b, 0) / this.hist.light.length : 0;
      const ratio = Math.round(HBO2.green / HBO2.red);
      this.card.querySelector('.story-note').textContent = params.led === 'green'
        ? `Blood more → light to the photodiodes less, and back again: each dip is one heartbeat. In a real wrist the change is only about 1–2%, invisible to your eye, but the watch measures it many times a second and counts the repeats. Haemoglobin absorbs green ${ratio}× more than red, so green shows the beat best.`
        : `With ${LED[params.led].name.toLowerCase()} light, blood swallows little: more light comes back (${(mean * 100).toFixed(0)}% here), but the beat barely changes it. That’s why watches use green.`;
    }
  }

  drawScreen(bpm, pop) {
    const c = this.screenCanvas.getContext('2d'), W = 256, H = 332;
    c.fillStyle = '#07090f'; c.fillRect(0, 0, W, H);
    c.save(); c.translate(W / 2, 108); c.scale(1 + 0.35 * pop, 1 + 0.35 * pop);
    c.fillStyle = '#ff4d6d'; c.beginPath();
    c.moveTo(0, 22); c.bezierCurveTo(-46, -6, -26, -40, 0, -18); c.bezierCurveTo(26, -40, 46, -6, 0, 22); c.fill();
    c.restore();
    c.fillStyle = '#ffffff'; c.font = '800 92px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText(Number.isFinite(bpm) ? Math.round(bpm) : '--', W / 2, 228);
    c.fillStyle = '#ff6b85'; c.font = '700 26px system-ui, sans-serif'; c.fillText('BPM', W / 2, 268);
    this.screenTex.needsUpdate = true;
  }

  placeLabels() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    const settled = performance.now() - this.viewSince > 1100;
    for (const L of this.labels) {
      const p = L.obj.localToWorld(L.pos.clone()).project(this.camera);
      const on = settled && !L.hide && L.views.includes(this.view) && p.z < 1 && Math.abs(p.x) < 0.95 && p.y < 0.9 && p.y > -0.75;
      L.el.style.opacity = on ? 1 : 0;
      if (on) { L.el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`; L.el.classList.toggle('flip', p.x > 0.35); }
    }
  }
}
