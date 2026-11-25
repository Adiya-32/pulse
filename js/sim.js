// sim.js — a simulated wrist: heart, blood, skin, LED, light sensor and accelerometer.
// It produces the same kind of number a real watch's photodiode produces (ADC counts),
// sample by sample, from the physics below. Nothing is pre-recorded.

// Per-colour constants (relative, order-of-magnitude values from the PPG literature):
//  ac      – fraction of light that each heartbeat removes (the pulse "depth") on a wrist.
//            Haemoglobin absorbs green far more than red or infrared, and green only reaches the
//            shallow, densely vascular dermis, so the pulsing part is a bigger share of the signal.
//  motion  – how strongly arm movement modulates the light. Red/IR travel deeper, through
//            tendons and veins that slosh when you move, so they pick up more motion.
//  melanin – how strongly skin pigment absorbs this colour (melanin absorbs short wavelengths most).
//  depth   – typical depth (mm) the detected light reaches; used for the cross-section picture.
export const LED = {
  green: { name: 'Green', nm: 530, ac: 0.020, motion: 1.0, melanin: 1.6, power: 2600, depth: 1.0, color: '#21c46b' },
  red:   { name: 'Red',   nm: 660, ac: 0.006, motion: 2.5, melanin: 0.6, power: 3000, depth: 2.5, color: '#ff4b4b' },
  ir:    { name: 'Infrared', nm: 940, ac: 0.004, motion: 2.8, melanin: 0.3, power: 3200, depth: 3.2, color: '#b06cff' },
};
export const ADC_MAX = 4095; // a 12-bit light sensor

// Shape of one heartbeat's pressure/volume wave, phase 0..1:
// a sharp systolic upstroke and a smaller reflected (dicrotic) wave after it.
// Real arterial pulses are lopsided: a fast upstroke when the heart contracts (systole), a slow
// fall-off, a small dip when the aortic valve closes (the dicrotic notch) and a second small
// bump just after it (the dicrotic wave), then a slow decline until the next beat.
export const PEAK_PHASE = 0.15;
export function pulseShape(ph) {
  const g = (x, m, s) => Math.exp(-((x - m) ** 2) / (2 * s * s));
  const systolic = ph < PEAK_PHASE ? g(ph, PEAK_PHASE, 0.055) : g(ph, PEAK_PHASE, 0.19);   // sharp rise, slow fall
  const notch = 0.1 * g(ph, 0.4, 0.03);                                                   // dicrotic notch
  const dicrotic = 0.2 * g(ph, 0.47, 0.06);                                               // dicrotic wave
  const tail = ph > 0.9 ? (ph - 0.9) * 0.5 : 0;                                           // joins smoothly to the next beat
  return Math.max(0, systolic - notch + dicrotic - tail);
}

function makeRng(seed = 12345) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()); // standard normal
}

export class WatchSim {
  constructor(fs = 30, seed = 7) {
    this.fs = fs;
    this.gauss = makeRng(seed);
    this.params = { bpm: 72, motion: 0, cadence: 150, led: 'green', fit: 0.9, melanin: 0.3 };
    this.t = 0; this.phase = 0; this.hrv = 0;
    this.stepPhase = 0; this.jit = 0; this.lag = 0;
    this.m1 = 0; this.m2 = 0;
    this.last = null;
  }

  step() {
    const p = this.params, dt = 1 / this.fs, g = this.gauss;
    this.t += dt;
    // Heart: rate wanders a little beat to beat (heart-rate variability).
    this.hrv += -0.03 * this.hrv + 0.003 * g();
    const rate = (p.bpm / 60) * (1 + this.hrv);
    const prev = this.phase;
    this.phase += rate * dt;
    if (this.phase >= 1) this.phase -= 1;
    // "beat" marks the moment of maximum blood volume (the top of the pulse wave).
    const beat = (prev < PEAK_PHASE && this.phase >= PEAK_PHASE) || (prev > this.phase && this.phase >= PEAK_PHASE);
    const pulse = pulseShape(this.phase); // 0..1 extra blood under the sensor

    // Arm: a jolt with every step (and its overtone), plus random jiggle.
    this.stepPhase += (p.cadence / 60) * dt;
    const swing = Math.sin(2 * Math.PI * this.stepPhase) + 0.3 * Math.sin(4 * Math.PI * this.stepPhase + 0.8);
    this.jit = 0.8 * this.jit + 0.2 * g();
    const m = p.motion * (0.8 * swing + 0.3 * this.jit); // wrist displacement (arbitrary units)
    // Tissue doesn't respond instantly; a small non-linearity means no filter removes it perfectly.
    this.lag += 0.35 * (m - this.lag);
    const motionTerm = this.lag + 0.25 * this.lag * this.lag;

    // Optics (Beer–Lambert): light reaching the sensor = emitted × skin transmission ×
    // e^(−extra absorption from blood) × motion modulation, + stray room light if the strap is loose.
    const led = LED[p.led], loose = 1 - p.fit;
    const skin = Math.exp(-led.melanin * p.melanin * 1.5);
    const dc = led.power * skin;
    const acEff = led.ac * (0.35 + 0.65 * p.fit);        // a gap lets light skim the surface instead
    const motionSens = 0.015 * led.motion * (1 + 3 * loose);
    const ambient = 2000 * loose * loose * (1 + 0.15 * Math.sin(2 * Math.PI * 0.07 * this.t)) * Math.max(0, 1 + 0.8 * m);
    let I = dc * Math.exp(-acEff * pulse) * (1 + motionSens * motionTerm) + ambient;
    I += Math.sqrt(Math.max(I, 1)) * 0.1 * g() + 1.0 * g(); // photon (shot) noise + electronics
    I = Math.min(ADC_MAX, Math.max(1, Math.round(I)));

    // Accelerometer: second derivative of the wrist position, plus its own small noise.
    const accel = (m - 2 * this.m1 + this.m2) * this.fs * this.fs / 250 + 0.02 * g();
    this.m2 = this.m1; this.m1 = m;

    this.last = {
      t: this.t, intensity: I, absorbance: -Math.log(I / ADC_MAX), accel, beat,
      trueBpm: rate * 60, pulse, motion: m, dc, ambient,
    };
    return this.last;
  }

  // Signal-to-noise estimate for any LED under the current settings, straight from the
  // model constants (used for the "why green?" comparison). Returns pulse amplitude
  // and noise amplitude, both as a fraction of the light level.
  static budget(params, ledKey) {
    const led = LED[ledKey], loose = 1 - params.fit;
    const dc = led.power * Math.exp(-led.melanin * params.melanin * 1.5);
    const ambient = 2000 * loose * loose;
    const level = dc + ambient;
    const pulse = (dc * led.ac * (0.35 + 0.65 * params.fit)) / level;
    const shot = (Math.sqrt(level) * 0.1 * Math.sqrt(2 * 2.8 / 30)) / level; // noise left in the 0.7–3.5 Hz band
    const motion = (dc * 0.015 * led.motion * (1 + 3 * loose) * 0.8 * params.motion + ambient * 0.8 * params.motion) / level;
    return { pulse, shot, motion, snr: pulse / Math.hypot(shot, motion) };
  }
}
