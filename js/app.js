// app.js — wires the simulator / camera to the processing pipeline and draws everything.
import { FS, PulseProcessor, Resampler } from './dsp.js?v=5';
import { WatchSim, LED } from './sim.js?v=5';
import { CameraSource } from './camera.js?v=5';
import { drawTrace, drawSpectrum } from './charts.js?v=5';

const $ = (s) => document.querySelector(s);
const WINDOW = 8 * FS;     // samples shown in the charts
const TICK_DELAY = 2;      // filter delay (samples) so true-beat marks line up with detected peaks

const proc = new PulseProcessor(FS);
const sim = new WatchSim(FS, (Math.random() * 1e9) | 0);
const resampler = new Resampler(FS);
const camera = new CameraSource($('#video'));

let scene3d = null; // the 3D view, if this browser can show it

const state = {
  mode: 'sim', simClock: null, trueBeats: [], trueBpms: [], analysis: null, lastAnalyze: 0,
  lastPeakSeen: -1, beatAt: -1e9, shownBpm: NaN, covered: false, camBpmSeen: false, simStart: performance.now(), done: new Set(),
};

// ---------------------------------------------------------------- cross-section picture
const vesselsG = $('#vessels');
const vessels = [];
for (let i = 0; i < 9; i++) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
  e.setAttribute('cx', 18 + i * 38 + (i % 2) * 8); e.setAttribute('cy', 104 + (i % 3) * 7);
  e.setAttribute('fill', 'var(--blood)'); e.setAttribute('opacity', '.85');
  vesselsG.appendChild(e); vessels.push(e);
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function updatePicture(s) {
  const p = sim.params, led = LED[p.led];
  const pulse = s ? s.pulse : 0, m = s ? s.motion : 0;
  vessels.forEach((e) => { e.setAttribute('rx', 9 + 3 * pulse); e.setAttribute('ry', 2.5 + 3.2 * pulse); });
  $('#artery').setAttribute('ry', 8 + 5 * pulse);
  const gap = (1 - p.fit) * 12 + Math.abs(m) * (2 + 8 * (1 - p.fit));
  $('#watch').setAttribute('transform', `translate(0 ${-gap.toFixed(1)})`);
  const depth = { green: 42, red: 95, ir: 118 }[p.led];
  const y0 = 64 - gap;
  const lp = $('#lightPath');
  lp.setAttribute('d', `M140 ${y0} Q170 ${64 + 2 * depth} 201 ${y0}`);
  lp.setAttribute('stroke', led.color);
  lp.setAttribute('opacity', (0.75 - 0.45 * pulse).toFixed(2));
  $('#led').setAttribute('fill', led.color);
  $('#ambientRays').setAttribute('opacity', Math.min(1, (1 - p.fit) * 1.6).toFixed(2));
  const skin = mix([243, 205, 178], [74, 44, 30], p.melanin);
  $('#epi').setAttribute('fill', `rgb(${skin})`);
  if (s) $('#sensorBar').setAttribute('width', Math.max(3, Math.min(40, (s.intensity / 2600) * 40)).toFixed(1));
  document.documentElement.style.setProperty('--accent', led.color);
}

// ---------------------------------------------------------------- controls
const motionWord = (v) => (v === 0 ? 'none' : v < 25 ? 'fidgeting' : v < 50 ? 'walking' : v < 75 ? 'jogging' : 'sprinting');
const fitWord = (v) => (v < 30 ? 'loose' : v < 70 ? 'so-so' : 'snug');
const skinWord = (v) => (v < 20 ? 'very light' : v < 45 ? 'light' : v < 70 ? 'medium' : v < 90 ? 'dark' : 'very dark');
const sliders = {
  bpm: (v) => { sim.params.bpm = v; return v; },
  motion: (v) => { sim.params.motion = v / 100; return `${motionWord(v)}${v ? ` (${v}%)` : ''}`; },
  cadence: (v) => { sim.params.cadence = v; return v; },
  fit: (v) => { sim.params.fit = v / 100; return fitWord(v); },
  melanin: (v) => { sim.params.melanin = v / 100; return skinWord(v); },
};
for (const [k, apply] of Object.entries(sliders)) {
  const el = $(`#c-${k}`), out = $(`#v-${k}`);
  const update = () => { out.textContent = apply(+el.value); };
  el.addEventListener('input', update); update();
}
$('#ledSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  sim.params.led = b.dataset.led;
  document.querySelectorAll('#ledSeg button').forEach((x) => x.classList.toggle('on', x === b));
});
$('#c-cancel').addEventListener('change', (e) => { proc.useMotionCancel = e.target.checked; });

// ---------------------------------------------------------------- modes
document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  document.querySelectorAll('.mode').forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  const cam = mode === 'cam';
  $('#simView').hidden = cam || !!scene3d; $('#stage3d').hidden = cam || !scene3d;
  $('#simControls').hidden = cam; $('#truthBox').hidden = cam; $('#tryit').hidden = cam;
  $('#camView').hidden = !cam;
  document.querySelectorAll('.sim-only').forEach((el) => { el.hidden = cam; });
  $('#rawHint').textContent = cam ? 'red light absorbed by your fingertip, last 8 s' : 'light absorbed, last 8 s';
  resetSignal();
  if (cam) {
    proc.useMotionCancel = false;
    document.documentElement.style.setProperty('--accent', '#ff4b4b');
  } else {
    camera.stop(); $('#camStart').textContent = 'Start camera'; $('#camTorch').hidden = true;
    proc.useMotionCancel = $('#c-cancel').checked;
    state.simClock = null;
    updatePicture(sim.last);
  }
}
function resetSignal() {
  proc.reset(); resampler.reset();
  state.trueBeats = []; state.trueBpms = []; state.analysis = null; state.lastPeakSeen = -1;
}

// ---------------------------------------------------------------- camera
$('#camStart').addEventListener('click', async () => {
  if (camera.running) { camera.stop(); $('#camStart').textContent = 'Start camera'; $('#camTorch').hidden = true; setCamStatus('Camera stopped.'); return; }
  try {
    setCamStatus('Asking for camera permission…');
    await camera.start();
    $('#camStart').textContent = 'Stop camera';
    $('#camTorch').hidden = !camera.torchSupported;
    $('#camTorch').textContent = `Torch: ${camera.torchOn ? 'on' : 'off'}`;
    setCamStatus('Now cover the lens completely with your fingertip.');
  } catch (err) {
    setCamStatus(`Couldn't open the camera: ${err.message || err.name}. The simulated watch still works.`);
  }
});
$('#camTorch').addEventListener('click', async () => {
  await camera.setTorch(!camera.torchOn);
  $('#camTorch').textContent = `Torch: ${camera.torchOn ? 'on' : 'off'}`;
});
function setCamStatus(t) { $('#camStatus').textContent = t; }
camera.onFrame = (f) => {
  if (state.mode !== 'cam') return;
  $('#camDot').classList.toggle('on', f.covered);
  if (!f.covered) {
    if (state.covered) resetSignal();
    state.covered = false;
    return;
  }
  if (!state.covered) { resetSignal(); state.covered = true; }
  // Absorbance of red light through the fingertip.
  const a = -Math.log(Math.max(f.r, 1) / 255);
  if (resampler.push(f.t, a, (v) => proc.push(v, 0))) proc.reset();
};

// ---------------------------------------------------------------- main loop
function stepSim(now) {
  if (state.simClock === null) state.simClock = now;
  let due = Math.floor(((now - state.simClock) / 1000) * FS);
  if (due > FS) { due = FS; state.simClock = now; } else state.simClock += (due * 1000) / FS;
  for (let i = 0; i < due; i++) {
    const s = sim.step();
    if (s.beat) state.trueBeats.push(proc.n);
    proc.push(s.absorbance, s.accel);
    state.trueBpms.push(s.trueBpm); if (state.trueBpms.length > WINDOW) state.trueBpms.shift();
  }
  while (state.trueBeats.length && state.trueBeats[0] < proc.n - WINDOW) state.trueBeats.shift();
}

// One bad frame must never stop the whole page: each part is guarded, and the next frame is
// always scheduled. If the 3D view keeps failing it is switched off and the flat picture shown.
function frame(now) {
  try { frameBody(now); } catch (err) { showError(err); }
  requestAnimationFrame(frame);
}
let scene3dErrors = 0;
function frameBody(now) {
  if (state.mode === 'sim') {
    stepSim(now); updatePicture(sim.last);
    if (scene3d) {
      try { scene3d.update(now, sim.last, sim.params, { bpm: state.shownBpm, beatAt: state.beatAt }); }
      catch (err) {
        if (++scene3dErrors > 5) { scene3d = null; $('#stage3d').hidden = true; $('#simView').hidden = false; }
        showError(err);
      }
    }
  }
  const len = Math.min(proc.raw.length, WINDOW);
  const start = proc.n - len;
  const raw = proc.raw.slice(-len), clean = proc.clean.slice(-len);
  const camWaiting = state.mode === 'cam' && !state.covered;
  drawTrace($('#cRaw'), camWaiting ? [] : raw, { color: getComputedStyle(document.documentElement).getPropertyValue('--accent'), length: WINDOW, phase: proc.n % FS,
    message: camera.running ? 'cover the lens with your fingertip' : 'press “Start camera”' });
  drawTrace($('#cClean'), camWaiting ? [] : clean, {
    color: getComputedStyle(document.documentElement).getPropertyValue('--ink'), length: WINDOW, phase: proc.n % FS,
    dots: proc.peaks.map((p) => p - start),
    ticks: state.mode === 'sim' ? state.trueBeats.map((b) => b - start + TICK_DELAY) : null,
    line: proc.thr.slice(-len), message: 'waiting for signal',
  });
  // pulse the heart icon when a new beat is detected
  const lp = proc.peaks.length ? proc.peaks[proc.peaks.length - 1] : -1;
  if (lp !== state.lastPeakSeen) {
    state.lastPeakSeen = lp;
    if (lp >= 0) { state.beatAt = now; const h = $('#beatHeart'); h.classList.add('pop'); setTimeout(() => h.classList.remove('pop'), 130); }
  }
  if (now - state.lastAnalyze > 250) { state.lastAnalyze = now; analyze(); }
}

// If something breaks, say so on the page (with the browser's name), so it can be reported
// from a phone where there is no developer console.
let errorShown = false;
function showError(err) {
  console.error(err);
  if (errorShown) return;
  errorShown = true;
  const b = document.createElement('div');
  b.className = 'error-banner';
  b.textContent = `Something went wrong in this browser: ${err && err.message ? err.message : err}  ·  ${navigator.userAgent}`;
  b.addEventListener('click', () => b.remove());
  document.body.appendChild(b);
}
window.addEventListener('error', (e) => showError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

// ---------------------------------------------------------------- numbers, verdicts, steps
const fmt = (v) => (Number.isFinite(v) ? Math.round(v) : '--');
function analyze() {
  const a = (state.analysis = proc.analyze());
  const p = sim.params, isSim = state.mode === 'sim';
  // Normally show the counted beats. If counting and the spectrum disagree, the counting
  // is being thrown off by extra/missed peaks, so trust the strongest rhythm instead.
  const shown = Number.isFinite(a.bpmPeaks) && Number.isFinite(a.bpmSpectrum) && Math.abs(a.bpmPeaks - a.bpmSpectrum) > 10
    ? a.bpmSpectrum : a.bpmPeaks;
  $('#bpm').textContent = fmt(shown);
  state.shownBpm = shown;
  const truth = state.trueBpms.length ? state.trueBpms.reduce((x, y) => x + y, 0) / state.trueBpms.length : NaN;
  const err = shown - truth;
  if (isSim) {
    $('#truth').textContent = fmt(truth);
    const e = $('#err');
    if (Number.isFinite(err)) {
      e.textContent = Math.abs(err) < 0.5 ? 'spot on' : `${err > 0 ? '+' : '−'}${Math.abs(Math.round(err))} off`;
      e.className = `err ${Math.abs(err) <= 5 ? 'good' : Math.abs(err) <= 12 ? 'warn' : 'bad'}`;
    } else { e.textContent = ''; }
  }
  const marks = [{ bpm: a.bpmSpectrum, color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), label: `strongest ${fmt(a.bpmSpectrum)}` }];
  if (isSim) {
    marks.push({ bpm: truth, color: getComputedStyle(document.documentElement).getPropertyValue('--heart').trim(), label: 'real heart', dash: true });
    if (p.motion > 0.05) marks.push({ bpm: p.cadence, color: getComputedStyle(document.documentElement).getPropertyValue('--motion').trim(), label: 'steps', dash: true });
  }
  drawSpectrum($('#cSpec'), a.spec, isSim && p.motion > 0.05 ? a.refSpec : null, marks);
  $('#pi').textContent = Number.isFinite(a.perfusion) ? `${a.perfusion.toFixed(1)}%` : '–';

  let verdict, cls = '';
  const disagree = Number.isFinite(a.bpmPeaks) && Number.isFinite(a.bpmSpectrum) && Math.abs(a.bpmPeaks - a.bpmSpectrum) > 10;
  if (isSim) {
    if (!Number.isFinite(shown)) verdict = 'Finding the rhythm… (needs a few beats)';
    else if (p.motion > 0.15 && Math.abs(a.bpmSpectrum - p.cadence) < 6 && Math.abs(truth - p.cadence) > 10) {
      verdict = 'Fooled: the strongest rhythm in the light is your steps, not your heart.'; cls = 'bad';
    } else if (Math.abs(err) <= 5) {
      verdict = p.motion > 0.3 && proc.useMotionCancel ? 'The accelerometer correction is subtracting your arm’s motion. Back on your heart.' : 'Locked on to your heartbeat.';
    } else if (Math.abs(err) <= 12) { verdict = 'Close, but movement is adding false beats or hiding real ones.'; cls = 'warn'; }
    else { verdict = 'Movement is drowning out the pulse. The reading is wrong.'; cls = 'bad'; }
    if (disagree && cls) verdict += ' (Counting and the strongest rhythm disagree, a sign the reading can’t be trusted.)';
    updateSteps(a, truth, err);
    updateSnr();
  } else {
    if (!camera.running) verdict = 'Start the camera to measure your own pulse.';
    else if (!state.covered) { verdict = 'Cover the whole lens with a fingertip.'; cls = 'warn'; }
    else if (!Number.isFinite(shown)) verdict = 'Hold still… collecting signal (about 5 seconds).';
    else if (a.quality < 0.3 || disagree) { verdict = 'Noisy signal: press gently, keep still, add light.'; cls = 'warn'; }
    else {
      verdict = 'That’s your pulse, measured by colour. Now wiggle your finger and watch it break.';
      if (!state.camBpmSeen) { state.camBpmSeen = true; markDone('cam'); }
    }
    if (camera.running) setCamStatus(state.covered ? 'Finger detected ✓  Keep still.' : 'Cover the lens completely with your fingertip.');
  }
  const v = $('#verdict'); v.textContent = verdict; v.className = `verdict ${cls}`;
}

const INSIGHTS = {
  light: 'Blood swallows green light. With every beat there is a little more blood under the watch, so a little less light gets back to the sensor. That dip is your pulse.',
  watch: 'The watch never feels your pulse. It watches your skin change colour, and a swinging arm changes the colour too.',
  move: 'Your swinging arm squeezes the tissue and shifts the strap. That changes the light by more than a heartbeat does.',
  lock: 'Steps are a steady rhythm in the same range as heartbeats, so to a light sensor they look exactly like a pulse. Runners see this bug on real watches: their step rate shows up as their heart rate.',
  cancel: 'The accelerometer feels only motion. An adaptive filter learns how that motion shows up in the light and subtracts it. What motion can’t explain is your heart.',
  red: 'Red light goes deeper and blood absorbs less of it, so the heartbeat is a smaller share of the light that returns and motion a bigger one. On a wrist, green is the best trade-off.',
  cam: 'Your camera just did what the watch does, using red light shining through your fingertip.',
};
function markDone(step) {
  if (state.done.has(step)) return;
  state.done.add(step);
  const li = document.querySelector(`#steps li[data-step="${step}"]`);
  li?.classList.add('done');
  $('#insight').textContent = INSIGHTS[step];
}
function updateSteps(a, truth, err) {
  const p = sim.params;
  const t = (performance.now() - state.simStart) / 1000;
  if (t > 6 && proc.peaks.length > 4) markDone('watch');
  if (p.motion >= 0.5 && Number.isFinite(err) && Math.abs(err) > 5) markDone('move');
  if (Math.abs(p.cadence - 120) <= 8 && p.motion > 0.3 && Math.abs(a.bpmSpectrum - p.cadence) < 6) markDone('lock');
  if (proc.useMotionCancel && p.motion > 0.3 && Math.abs(err) <= 5) markDone('cancel');
  if (p.led === 'red' && p.motion > 0.2) markDone('red');
}

function updateSnr() {
  const rows = Object.keys(LED).map((k) => ({ k, ...WatchSim.budget(sim.params, k) }));
  const max = Math.max(...rows.map((r) => r.snr), 1e-6);
  $('#snr').innerHTML = rows.map((r) => `
    <div class="snr-row"><span style="color:${LED[r.k].color}">${LED[r.k].name}</span>
    <span class="snr-bar"><i style="width:${(100 * r.snr / max).toFixed(1)}%;background:${LED[r.k].color}"></i></span>
    <span class="v">${(Math.round(20 * Math.log10(r.snr)) || 0)} dB</span></div>`).join('');
}

updatePicture(null);
updateSnr();

// Load the 3D view. If WebGL or the library can't load, the flat picture stays.
import('./scene3d.js?v=5').then(({ PulseScene }) => {
  const root = $('#scene3d');
  $('#stage3d').hidden = false;
  try {
    scene3d = new PulseScene(root, {
      onLost: () => {          // the phone took the graphics memory back: carry on in 2D
        scene3d = null;
        $('#stage3d').hidden = true; $('#simView').hidden = state.mode === 'cam';
        $('#xsec').removeAttribute('hidden');
      },
      onView: (v) => {
        clearTimeout(state.lightTimer);
        if (v === 'light') state.lightTimer = setTimeout(() => markDone('light'), 4000);
      },
    });
    $('#simView').hidden = true;
  } catch (err) {
    $('#stage3d').hidden = true; $('#simView').hidden = false; showError(err);
  }
}).catch((err) => { console.warn('3D view unavailable:', err); showError(err); });
requestAnimationFrame(frame);
