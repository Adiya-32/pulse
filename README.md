# Pulse in the Light

**How a smartwatch measures your heart rate, and why it gets it wrong when you run.**

A smartwatch doesn't feel your pulse. A green LED shines into your wrist, and each heartbeat pushes a little more blood under the skin. Blood absorbs green light, so a sensor next to the LED sees the light dim slightly and recover about once a second. The watch counts those dips. This method is called *photoplethysmography* (PPG).

This project lets you run that mechanism yourself:

- **3D view** (top of the page): a low-poly wrist and watch, moved live by the simulation, with a side card explaining what you see. Four views, in the order of the story:
  - *Outside*: the watch on the arm, green glow on the skin, the live reading on the watch face. The arm moves and the strap lifts exactly as the simulated wrist does.
  - *Sensors*: the watch lifts off and turns over to show its back: green LEDs and photodiodes (light sensors).
  - *Inside*: on each heartbeat a pulse wave (bright ring) runs down the artery, red blood cells surge, the tiny arteries under the watch fill and glow. Veins (blue) carry blood back steadily and don't pulse; tendons and bone stay still.
  - *Light in skin*: a side cut through the skin under the watch, drawn from the same numbers the light simulation uses: skin with pigment, three tiny arteries and a vein **full of individual red blood cells** (they flow along, faster on each beat), fat, a deeper artery. As the pulse wave passes, the tiny arteries widen and more cells fit inside. Light dots from the LEDs are simulated live, one scattering step at a time, against the cells as they are now: a dot whose path crosses a red blood cell is usually swallowed by its haemoglobin (the cell flashes); others are absorbed by tissue, leave the skin, or reach a photodiode. The card shows live percentages, a "blood MORE / light LESS" panel and two synced graphs. Switch to red: haemoglobin barely absorbs it and the beat barely shows.
    Details that follow the physiology and optics: the pulse wave has the real lopsided shape (fast rise, slow fall, dicrotic notch and second bump) and travels along the vessels from the elbow side, lighting up the artery wall where it passes, with the cells surging locally; arterial cells are bright scarlet, venous ones dark burgundy and steady. A soft glow builds up from the simulated paths of the light that actually reached a photodiode: it bends down into the vessels and back up (the "banana-shaped" path known in biophotonics), which is why the LEDs and photodiodes sit a few millimetres apart. The photodiode glows when light arrives, and each arrival puts a tick on the PPG graph.
- **Simulated watch** (starts immediately): a physical model of a wrist (heart, blood, skin, LED, light sensor, accelerometer) produces a raw sensor reading sample by sample. The same pipeline a watch uses turns it into beats per minute. Sliders change heart rate, arm movement, step rhythm, strap fit, LED colour and skin tone. The page shows the true pulse next to what the "watch" reads.
- **Your fingertip + camera**: cover your phone's camera (or a laptop webcam with a lamp behind your finger). The same pipeline measures your real pulse from the colour of your fingertip.

## The one idea

> The watch measures the *colour of your skin*, not your heartbeat. Anything else that changes that colour also changes the reading. A swinging arm does, and if your steps keep a steady rhythm, the watch can count your steps as heartbeats.

The two-minute path on the page ("Try this") leads a first-time user through it:
1. see each counted beat line up with the real ones;
2. add arm movement and watch the reading drift;
3. set the step rhythm to 120/min: the watch locks onto the steps;
4. switch on accelerometer motion cancelling: the heart comes back;
5. switch the LED to red and see why watches use green;
6. measure your own pulse with the camera.

## How it works (all in our own code, no libraries)

| File | What it does |
|---|---|
| `js/sim.js` | The wrist model. Heart rate with beat-to-beat variability; a pulse-wave shape (systolic peak + dicrotic wave); Beer–Lambert optics `I = I0 · skin · e^(−ac·pulse) · (1 + motion)` + stray room light when the strap is loose; photon (shot) noise; 12-bit sensor; accelerometer = 2nd derivative of wrist movement. Per-colour constants (pulse depth, motion sensitivity, melanin absorption) are order-of-magnitude values. |
| `js/dsp.js` | The mechanism. `−log(light)` to linearise Beer–Lambert → drift removal → biquad band-pass 0.5–3.5 Hz (30–210 BPM) → optional NLMS adaptive filter that subtracts what the accelerometer predicts → peak detection (local max in ±0.25 s, adaptive threshold at 50% of recent max, refractory period that rejects the dicrotic wave, sub-sample timing by parabolic fit) → BPM from the median beat interval. Cross-checked by a Hann-windowed DFT over the last 8 s. Also computes the perfusion index (AC/DC). |
| `js/photons.js` | Monte Carlo light transport in a side cut through the skin (x along the arm, depth down). Blood is modelled as individual red blood cells: each vessel has a pool of cells, and a cell counts as inside only while it fits within the vessel's current radius, so a widening vessel holds more cells. Every scattering step computes the exact distance the photon travels through cells (line-circle intersection, with a grid to find nearby cells) and absorbs with e^(−μ_Hb·distance in cells − μ_tissue·step − μ_melanin·distance in the top layer). Three uses: live step-by-step dots, an all-or-nothing tracer for the percentages, and the low-noise "photon weight" method (as in MCML) run for 6 blood levels and cached for the *light at the sensor* graph. |
| `js/scene3d.js` | The 3D scene. Draws the arm, watch, vessels, blood cells and light packets, all moved by `sim.js` and `photons.js`. |
| `js/camera.js` | Opens the camera (back camera, torch if the browser allows), shrinks each frame to 40×30, averages the red channel, and checks the lens is covered (red dominant, no detail). Nothing leaves the device. |
| `js/charts.js` | Canvas plotting of the three pipeline stages. |
| `js/app.js` | Wiring, the cross-section picture, readouts, the guided steps. |
| `tests/pipeline.test.mjs` | Runs the simulator through the pipeline and checks it against the truth. |

### Why these choices
- **Three.js for the 3D view** (open-source, loaded from the jsDelivr CDN, version pinned to 0.160.0): writing a WebGL renderer by hand would take days and explain nothing about pulse sensing. It only draws; it computes none of the mechanism. If it can't load, the page falls back to a flat 2D picture and everything else still works.
- **Monte Carlo for the light**: light in skin doesn't travel in straight lines; it scatters dozens of times. Simulating packets one by one is the standard way tissue optics is computed, and it shows directly why green stays shallow (where the capillaries are) and red goes deep.
- **Absorbance (−log) instead of raw light**: makes the pulse size independent of brightness, so the band-passed amplitude *is* the perfusion index.
- **Peaks and spectrum together**: counting peaks follows the heart beat by beat; the spectrum is robust but slow. When they disagree by more than 10 BPM the page trusts the spectrum and says the reading is unreliable.
- **NLMS for motion**: it needs no model of the arm. It learns the motion-to-light relationship from the accelerometer as it goes. It cannot help when the step rate equals the heart rate, because then motion and pulse look identical; the page says so.
- **Red for the camera, green for the watch**: a watch looks at light scattered back from the top millimetre of skin (reflectance). A camera with a finger on it looks at light that went *through* the finger (transmission), and only red gets through.

## Run it

It's a static site with no build step.

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. The camera needs `https` or `localhost`.

Run the tests (Node 22+):

```bash
node tests/pipeline.test.mjs
```

The tests check the light simulation (red returns more light than green; a heartbeat dims green far more than red; darker skin returns less green light) and the pulse pipeline: resting heart rates 50–150 BPM read within ±4 BPM (several random seeds); the perfusion index is in a realistic 1–3% range; running at 120 steps/min fools the watch; accelerometer cancelling recovers the true pulse within ±5 BPM; red does worse than green under the same motion.

### Deploy to GitHub Pages
Push to a public repo → Settings → Pages → "Deploy from a branch" → `main` / root. The `.nojekyll` file makes Pages serve the files as they are.

## Limitations (honest list)
- The idea and the order of the explanation follow a short explainer video the team used as a reference; all models, code and text here are our own.
- The light-in-skin cut is not to scale; the tiny arteries widen far more than real ones (a few %) so it can be seen (green really reaches ~1 mm deep), and the green/red absorption ratio is compressed (real ≈ 100×, here 20×) so both colours show something.
- The tissue constants are plausible magnitudes, not measured optics; the model is meant to behave correctly, not to match a specific watch.
- At 30 samples/s, timing per beat is ±17 ms; above ~180 BPM peak counting starts reading a few beats low.
- Real watches use several LEDs/photodiodes, automatic LED brightness and trained models on top of this kind of filtering.
- Camera mode depends on lighting: iPhone browsers can't switch on the torch, so a lamp nearby helps. A covered-lens check (red dominant, no detail) decides when to measure.
- SpO₂ (blood oxygen) uses the same sensor with red and infrared together; not covered here.
- Not a medical device.
