// camera.js — reads the average colour of each camera frame while a fingertip covers the lens.
// Through a finger the light has to pass *through* tissue, and only red survives that,
// so the camera mode uses the red channel (a watch, shining green into the wrist surface, uses green).

export class CameraSource {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 40; this.canvas.height = 30;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.stream = null; this.track = null; this.running = false;
    this.torchSupported = false; this.torchOn = false;
    this.onFrame = () => {};
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open a camera (it needs https and a modern browser).');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } },
    });
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    this.video.muted = true; this.video.playsInline = true;
    await this.video.play();
    const caps = this.track.getCapabilities?.() || {};
    this.torchSupported = !!caps.torch;
    if (this.torchSupported) await this.setTorch(true);
    this.running = true;
    this.loop();
  }

  async setTorch(on) {
    if (!this.torchSupported) return false;
    try { await this.track.applyConstraints({ advanced: [{ torch: on }] }); this.torchOn = on; } catch { this.torchOn = false; }
    return this.torchOn;
  }

  loop() {
    if (!this.running) return;
    const v = this.video;
    const next = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => this.loop()) : requestAnimationFrame(() => this.loop()));
    if (v.readyState >= 2) {
      this.ctx.drawImage(v, 0, 0, 40, 30);
      const d = this.ctx.getImageData(0, 0, 40, 30).data;
      let r = 0, g = 0, b = 0, rr = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; rr += d[i] * d[i]; }
      r /= n; g /= n; b /= n;
      const spread = Math.sqrt(Math.max(0, rr / n - r * r));
      // A fingertip over the lens turns the whole picture an even red: red dominates and
      // there is no detail left (low spread across pixels).
      const covered = r > 20 && r > 1.6 * g && r > 1.6 * b && spread < 30;
      this.onFrame({ t: performance.now() / 1000, r, g, b, spread, covered });
    }
    next();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null; this.torchOn = false;
    this.video.srcObject = null;
  }
}
