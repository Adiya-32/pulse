// dsp.js — the mechanism: turning a flickering brightness reading into beats per minute.
// Everything here is plain arithmetic; no libraries. Same code runs on camera and simulated data.

export const FS = 30; // samples per second after resampling (a typical watch samples PPG at 25–100 Hz)

// ---------------------------------------------------------------------------
// Biquad: a 2nd-order IIR filter (RBJ "Audio EQ Cookbook" formulas),
// run in transposed direct form II.
export class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    Object.assign(this, { b0, b1, b2, a1, a2 });
    this.z1 = 0; this.z2 = 0;
  }
  static lowpass(fc, fs, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * fc) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
  }
  static highpass(fc, fs, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * fc) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return new Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = this.z2 = 0; }
}

// Band-pass 0.5–3.5 Hz = 30–210 beats per minute. Anything slower (breathing, drift,
// pressing harder) or faster (sensor hiss, flicker) cannot be a heartbeat.
export const BAND_LO = 0.5, BAND_HI = 3.5;
export class Bandpass {
  constructor(fs, lo = BAND_LO, hi = BAND_HI) {
    this.stages = [Biquad.highpass(lo, fs), Biquad.lowpass(hi, fs), Biquad.lowpass(hi, fs)];
  }
  process(x) { for (const s of this.stages) x = s.process(x); return x; }
  reset() { this.stages.forEach((s) => s.reset()); }
}

// Removes the large steady level (the "DC") with a slow moving average, so the filters
// don't ring when the signal first arrives.
export class DCRemover {
  constructor(fs, tau = 1.5) { this.a = 1 - Math.exp(-1 / (fs * tau)); this.m = null; }
  process(x) { if (this.m === null) this.m = x; this.m += this.a * (x - this.m); return x - this.m; }
  reset() { this.m = null; }
}

// Cameras deliver frames at uneven times. Linear interpolation turns them into
// evenly spaced samples, which the filters require.
export class Resampler {
  constructor(fs) { this.fs = fs; this.reset(); }
  reset() { this.pt = null; this.pv = 0; this.next = 0; }
  // Calls out(value) for each new evenly spaced sample. Returns true if it had to restart (a gap).
  push(t, v, out) {
    if (this.pt === null || t - this.pt > 0.5 || t <= this.pt) {
      const restarted = this.pt !== null;
      this.pt = t; this.pv = v; this.next = t;
      return restarted;
    }
    while (this.next <= t) {
      const a = (this.next - this.pt) / (t - this.pt);
      out(this.pv + a * (v - this.pv));
      this.next += 1 / this.fs;
    }
    this.pt = t; this.pv = v;
    return false;
  }
}

// Normalised least-mean-squares adaptive filter. Given a reference that "sees" only the
// motion (the watch's accelerometer), it learns how motion leaks into the light signal
// and subtracts its best guess. Whatever it cannot predict from motion is kept: the pulse.
export class NLMS {
  constructor(taps = 16, mu = 0.05) {
    this.w = new Float64Array(taps); this.u = new Float64Array(taps); this.mu = mu;
  }
  process(x, ref) {
    const { w, u } = this;
    u.copyWithin(1, 0); u[0] = ref;
    let y = 0, p = 1e-9;
    for (let i = 0; i < w.length; i++) { y += w[i] * u[i]; p += u[i] * u[i]; }
    const e = x - y;
    const g = (this.mu * e) / p;
    for (let i = 0; i < w.length; i++) w[i] += g * u[i];
    return e;
  }
  reset() { this.w.fill(0); this.u.fill(0); }
}

// Power at frequencies f (Hz) of the last samples, with a Hann window. A direct DFT at
// chosen frequencies: slower than an FFT but lets us pick a fine, even grid in BPM.
export function spectrum(x, fs, fLo = 0.5, fHi = 3.6, step = 0.02) {
  const N = x.length, freqs = [], power = [];
  if (N < 8) return { freqs, power };
  let mean = 0; for (const v of x) mean += v; mean /= N;
  const xw = new Float64Array(N);
  for (let i = 0; i < N; i++) xw[i] = (x[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  for (let f = fLo; f <= fHi + 1e-9; f += step) {
    const w = (2 * Math.PI * f) / fs;
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) { re += xw[i] * Math.cos(w * i); im -= xw[i] * Math.sin(w * i); }
    freqs.push(f); power.push((re * re + im * im) / N);
  }
  return { freqs, power };
}

function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// The whole pipeline: raw light → remove drift → band-pass → (optional) motion
// cancellation → peak picking → beats per minute, cross-checked against the spectrum.
export class PulseProcessor {
  constructor(fs = FS) {
    this.fs = fs;
    this.useMotionCancel = false;
    this.keep = fs * 12; // seconds of history kept
    this.reset();
  }
  reset() {
    const fs = this.fs;
    this.n = 0;               // total samples ever pushed
    this.dc = new DCRemover(fs); this.dcRef = new DCRemover(fs);
    this.bp = new Bandpass(fs); this.bpRef = new Bandpass(fs);
    this.nlms = new NLMS(24, 0.1);
    this.raw = []; this.band = []; this.clean = []; this.ref = [];
    this.peaks = [];          // absolute sample indices of detected beats
    this.peakTimes = [];      // same, refined to fractions of a sample
    this.thr = [];            // threshold used at each sample (for drawing)
    this.lastPeak = -1e9; this.lastIbi = 0;
  }
  get base() { return this.n - this.raw.length; } // absolute index of raw[0]

  push(x, ref = 0) {
    const f = this.bp.process(this.dc.process(x));
    const r = this.bpRef.process(this.dcRef.process(ref));
    const e = this.nlms.process(f, r); // always adapting, so the toggle acts instantly
    this.raw.push(x); this.band.push(f); this.clean.push(this.useMotionCancel ? e : f); this.ref.push(r);
    this.n++;
    if (this.raw.length > this.keep) {
      this.raw.shift(); this.band.shift(); this.clean.shift(); this.ref.shift(); this.thr.shift();
    }
    this.thr.push(this.detectPeak());
    while (this.peaks.length && this.peaks[0] < this.base) { this.peaks.shift(); this.peakTimes.shift(); }
  }

  // A sample is a beat if it is the highest point within ±0.25 s, stands above an adaptive
  // threshold (50% of the biggest swing in the last 2 s) and comes at least 0.3 s after the
  // previous beat (a heart can't beat faster than ~200/min) — or, once a rhythm is known, at
  // least 45% of the last gap (capped at 0.5 s), so the smaller second wave of each beat
  // (the dicrotic wave) isn't counted as an extra beat.
  detectPeak() {
    const { fs, clean } = this;
    const H = Math.round(0.25 * fs);
    const L = clean.length;
    if (this.n < 2 * fs || L < 2 * H + 1) return 0;
    const c = L - 1 - H, v = clean[c];
    let hi = 0;
    for (let i = Math.max(0, c - 2 * fs); i < c; i++) hi = Math.max(hi, clean[i]);
    const thr = 0.5 * hi;
    for (let i = c - H; i <= c + H; i++) if (clean[i] > v) return thr;
    const abs = this.base + c;
    const refractory = Math.min(Math.max(0.3 * fs, 0.45 * this.lastIbi), 0.5 * fs);
    if (v > 0 && v >= thr && abs - this.lastPeak >= refractory) {
      const gap = abs - this.lastPeak;
      this.lastIbi = gap <= 1.6 * fs ? gap : 0;
      this.peaks.push(abs); this.lastPeak = abs;
      // Fit a parabola through the peak and its neighbours: sub-sample timing.
      const [a, b, cc] = [clean[c - 1], v, clean[c + 1]], d = a - 2 * b + cc;
      this.peakTimes.push(abs + (d < 0 ? (0.5 * (a - cc)) / d : 0));
    }
    return thr;
  }

  analyze() {
    const { fs } = this;
    const win = Math.min(this.clean.length, 8 * fs);
    const out = { bpmPeaks: NaN, bpmSpectrum: NaN, quality: 0, perfusion: NaN, spec: null, refSpec: null, ibis: [] };
    // 1) Counting: median gap between recent beats.
    const recent = this.peakTimes.filter((p) => p >= this.n - 10 * fs);
    for (let i = 1; i < recent.length; i++) {
      const ibi = (recent[i] - recent[i - 1]) / fs;
      if (ibi >= 0.28 && ibi <= 1.6) out.ibis.push(ibi);
    }
    if (out.ibis.length >= 3) out.bpmPeaks = 60 / median(out.ibis.slice(-8));
    if (win < 4 * fs) return out;
    // 2) Rhythm: strongest repeating frequency in the band over the last 8 s.
    const seg = this.clean.slice(-win);
    const spec = spectrum(seg, fs);
    out.spec = spec;
    out.refSpec = spectrum(this.ref.slice(-win), fs);
    let k = 0, total = 0;
    spec.power.forEach((p, i) => { total += p; if (p > spec.power[k]) k = i; });
    // parabolic interpolation around the peak bin for sub-bin accuracy
    let f = spec.freqs[k];
    if (k > 0 && k < spec.power.length - 1) {
      const [a, b, c] = [spec.power[k - 1], spec.power[k], spec.power[k + 1]];
      const d = a - 2 * b + c;
      if (d !== 0) f += (0.5 * (a - c) / d) * (spec.freqs[1] - spec.freqs[0]);
    }
    out.bpmSpectrum = f * 60;
    let near = 0;
    spec.freqs.forEach((fq, i) => { if (Math.abs(fq - spec.freqs[k]) <= 0.12) near += spec.power[i]; });
    out.quality = total > 0 ? near / total : 0;
    // 3) Perfusion index. The input is absorbance (−ln of light), so a small swing in it
    // equals the fractional swing in light: AC/DC. Use the 5th–95th percentile range.
    const b = this.band.slice(-win).sort((p, q) => p - q);
    out.perfusion = (b[Math.floor(b.length * 0.95)] - b[Math.floor(b.length * 0.05)]) * 100;
    return out;
  }
}
