// charts.js — small canvas plotting helpers (no chart library: we only need lines and dots).

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function prep(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width: w, height: h } = canvas.getBoundingClientRect();
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function robustRange(data) {
  const s = [...data].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return [0, 1];
  let lo = s[Math.floor(s.length * 0.01)], hi = s[Math.floor(s.length * 0.99)];
  if (hi - lo < 1e-9) { lo -= 1e-3; hi += 1e-3; }
  const pad = (hi - lo) * 0.15;
  return [lo - pad, hi + pad];
}

// data: values, one per sample. opts: color, fs, dots (indices), ticks (indices), line (y value),
// message (shown when empty).
export function drawTrace(canvas, data, opts = {}) {
  const { ctx, w, h } = prep(canvas);
  const fs = opts.fs || 30, N = opts.length || data.length;
  ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
  for (let s = 0; s * fs < N; s++) { // one gridline per second, scrolling with the data
    const x = w - ((s * fs + (opts.phase || 0)) / (N - 1)) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  if (data.length < 2) {
    if (opts.message) { ctx.fillStyle = css('--muted'); ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(opts.message, w / 2, h / 2); }
    return;
  }
  const [lo, hi] = opts.range || robustRange(data);
  const X = (i) => w - ((data.length - 1 - i) / (N - 1)) * w;
  const Y = (v) => h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h;
  if (opts.line !== undefined) {
    ctx.setLineDash([4, 4]); ctx.strokeStyle = css('--muted');
    ctx.beginPath();
    if (Array.isArray(opts.line)) opts.line.forEach((v, i) => { const x = X(i + data.length - opts.line.length); i ? ctx.lineTo(x, Y(v)) : ctx.moveTo(x, Y(v)); });
    else { ctx.moveTo(0, Y(opts.line)); ctx.lineTo(w, Y(opts.line)); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = opts.color || css('--ink'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();
  if (opts.ticks) { // ground-truth beats, as small marks along the bottom
    ctx.fillStyle = css('--heart');
    for (const i of opts.ticks) if (i >= 0 && i < data.length) ctx.fillRect(X(i) - 1.5, h - 10, 3, 10);
  }
  if (opts.dots) {
    for (const i of opts.dots) {
      if (i < 0 || i >= data.length) continue;
      ctx.beginPath(); ctx.arc(X(i), Y(data[i]), 5, 0, Math.PI * 2);
      ctx.fillStyle = css('--panel'); ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = css('--heart'); ctx.stroke();
    }
  }
}

// spec: {freqs, power}; marks: [{bpm, color, label, dash}]
export function drawSpectrum(canvas, spec, refSpec, marks = []) {
  const { ctx, w, h } = prep(canvas);
  const bpmLo = 30, bpmHi = 216;
  const X = (bpm) => ((bpm - bpmLo) / (bpmHi - bpmLo)) * w;
  ctx.fillStyle = css('--muted'); ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
  for (let b = 40; b <= 200; b += 20) {
    ctx.beginPath(); ctx.moveTo(X(b), 0); ctx.lineTo(X(b), h - 16); ctx.stroke();
    ctx.fillText(b, X(b), h - 3);
  }
  if (!spec || !spec.power.length) {
    ctx.fillText('collecting a few seconds of signal…', w / 2, h / 2);
    return;
  }
  const max = Math.max(...spec.power) || 1;
  const plot = (s, color, fill) => {
    const m = fill ? max : Math.max(...s.power) || 1;
    ctx.beginPath();
    s.freqs.forEach((f, i) => { const x = X(f * 60), y = (h - 18) * (1 - (s.power[i] / m) * 0.92); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (fill) { ctx.lineTo(X(s.freqs[s.freqs.length - 1] * 60), h - 18); ctx.lineTo(X(s.freqs[0] * 60), h - 18); ctx.closePath(); ctx.fillStyle = color; ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1; }
    else { ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]); }
  };
  if (refSpec) plot(refSpec, css('--motion'), false);
  plot(spec, css('--accent'), true);
  ctx.beginPath();
  spec.freqs.forEach((f, i) => { const x = X(f * 60), y = (h - 18) * (1 - (spec.power[i] / max) * 0.92); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2; ctx.stroke();
  marks.forEach((m, k) => {
    if (!Number.isFinite(m.bpm)) return;
    const x = X(m.bpm);
    ctx.strokeStyle = m.color; ctx.lineWidth = 2; ctx.setLineDash(m.dash ? [5, 4] : []);
    ctx.beginPath(); ctx.moveTo(x, 12 + k * 14); ctx.lineTo(x, h - 18); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = m.color; ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = x > w - 70 ? 'right' : x < 70 ? 'left' : 'center';
    ctx.fillText(m.label, x, 10 + k * 14);
  });
}
