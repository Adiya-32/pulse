// Runs the simulator through the real pipeline and checks the reading against the truth.
import { PulseProcessor, FS, spectrum } from '../js/dsp.js';
import { WatchSim } from '../js/sim.js';
import { detectedFraction } from '../js/photons.js';

function run(params, { seconds = 30, cancel = false, seed = 7 } = {}) {
  const sim = new WatchSim(FS, seed); Object.assign(sim.params, params);
  const proc = new PulseProcessor(FS); proc.useMotionCancel = cancel;
  for (let i = 0; i < seconds * FS; i++) { const s = sim.step(); proc.push(s.absorbance, s.accel); }
  const a = proc.analyze();
  return { peaks: a.bpmPeaks, spec: a.bpmSpectrum, q: a.quality, pi: a.perfusion };
}
let fails = 0;
function check(name, cond, info) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(info, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)}`); if (!cond) fails++; }

// Pure tone sanity: spectrum finds 1.5 Hz
{ const x = Array.from({ length: 240 }, (_, i) => Math.sin(2 * Math.PI * 1.5 * i / FS));
  const s = spectrum(x, FS); const k = s.power.indexOf(Math.max(...s.power));
  check('spectrum finds 1.5 Hz', Math.abs(s.freqs[k] - 1.5) < 0.03, { f: s.freqs[k] }); }

for (const bpm of [50, 72, 100, 150]) {
  for (const seed of [1, 2, 3]) {
    const r = run({ bpm }, { seed });
    check(`rest bpm=${bpm} seed=${seed}`, Math.abs(r.peaks - bpm) < 4 && Math.abs(r.spec - bpm) < 4, r);
  }
}
const pi = run({ bpm: 72 });
check('perfusion index ~1-2% for green', pi.pi > 0.8 && pi.pi < 3, pi);

// Running: cadence 120 steps/min, pulse 80, heavy motion -> watch should be fooled
const fooled = run({ bpm: 80, motion: 0.7, cadence: 120 });
check('motion fools it (locks near cadence or far off)', Math.abs(fooled.spec - 80) > 10, fooled);
const fixed = run({ bpm: 80, motion: 0.7, cadence: 120 }, { cancel: true, seconds: 40 });
check('accelerometer cancel recovers pulse', Math.abs(fixed.spec - 80) < 5 && Math.abs(fixed.peaks - 80) < 6, fixed);

// Red LED worse than green under the same moderate motion
const g = run({ bpm: 75, motion: 0.3, cadence: 140, led: 'green' });
const rd = run({ bpm: 75, motion: 0.3, cadence: 140, led: 'red' });
check('green beats red with motion', Math.abs(g.spec - 75) < 5, { g, rd });

// Photon Monte Carlo (the "Light path" view)
{ const N = 100000, f = (led, p, mel = 0.3) => detectedFraction(led, p, mel, N);
  const g0 = f('green', 0), g1 = f('green', 1), r0 = f('red', 0), r1 = f('red', 1);
  check('light: red returns more light than green', r0 > 2 * g0, { g0, r0 });
  check('light: a heartbeat dims green far more than red', (1 - g1 / g0) > 3 * Math.abs(1 - r1 / r0) && (1 - g1 / g0) > 0.15, { greenDip: 1 - g1 / g0, redDip: 1 - r1 / r0 });
  check('light: darker skin returns less green light', f('green', 0, 0.9) < 0.7 * g0, { light: g0, dark: f('green', 0, 0.9) }); }

console.log(fails ? `\n${fails} failing` : '\nall passing');
process.exit(fails ? 1 : 0);
