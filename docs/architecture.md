# StickCam architecture

The design detail behind the map in `../CLAUDE.md`.

## Data flow

```
.bbl bytes ─ repairLegacyDump → listFlights → decodeFlight ─┐
                                                            ├─ prepare(): buildSignals + armedSpan → FlightData
demo.ts (synthetic DecodedFlight) ──────────────────────────┘
FlightData ─ buildTrack(fps, logStart, logEnd) → Track ─ analyzeMotion(mode) → Motion
Track + Motion + Style + Settings ─ createScene(scale) → Scene ─ renderFrame(ctx, scene, i)
                                                                     ├─ preview <canvas> (scale = device px)
                                                                     └─ export (scale 1): Mediabunny / ffmpeg.wasm
video File ─ openVideo → VideoInfo ─ analyzeFlow → FlowSample[] ─ findOffset(flow, sig) → offset
```

## Decoder (`src/decoder/`)

- These are copies of fpvstream's viewer decoder. It handles I/P/S/G/H/E frames, every encoding (including Elias delta and tag8/tag2) and every predictor. It flags suspect frames after damaged bytes and resyncs on garbage.
- `buildSignals` turns the raw columns into physical units: `t` (seconds from the first sample), `stick[0..2]`, `throttle`, `gyro` (deg/s), `acc` (g), `motorMean`, `attitude` and more.
- Our `.d.ts` files only declare what we use.

## Track (`src/track.ts`)

- `throttleRange(raw)` uses `minthrottle..maxthrottle` when the header has them, else 1000..2000.
- `buildTrack(data, fps, start, end)`: for every output frame, takes the nearest log sample. If it is more than 0.15 s away the frame is not live, and the dot rests dimmed at the centre.
- `armedSpan` reads flightModeFlags bit 0 from the S-frames, ignoring values above 0xFFFF (damage). The default trim is that span −0.5 s / +2.5 s, so the outro and crash show.

## Motion and events (`src/motion.ts`)

- `gimbalPositions` handles the stick-mode mapping:
  - Mode 2: left = (yaw, 1 − 2·thr), right = (roll, −pitch).
  - Mode 1: pitch and throttle swap sides.
  - y points down, so stick up = −1.
- Speed: the frame-to-frame distance × fps, with one-pole smoothing (~35 ms).
- **Snap:** deflection above 95 % at speed above `snapSpeed` (5); re-armed below 80 %. The throttle axis is excluded, because chops are routine.
- **Punch:** throttle rises more than 45 % within 0.4 s from below 35 %; re-armed below 30 %.
- **Tricks:** the full-rate gyro is integrated per axis (pitch = flip, roll = roll, yaw = spin).
  - A run starts above 280 °/s (spin: ×1.4) and continues while above 140 °/s. It ends after 0.2 s of quiet or a sign flip.
  - A turn counts at 330°.
  - Events of the same kind less than 0.7 s × turns apart merge, so a double flip emits once with `turns=2`.
- **Combo:** tricks less than 1.6 s apart chain (shown as COMBO ×n; there are no points).
- **Crash:** an acceleration spike above 6 g in the 1.5 s before disarm. The card lands on the impact; otherwise a plain DISARMED.
- **Full throttle / hang time:** spans on the full-rate throttle (normalised with `throttleRange`), so `t0` and `dur` are exact seconds, not frame-quantised. Dips ≤ 60 ms don't split a span.
  - Full: ≥ 98 % for ≥ 0.3 s → `FULL SEND`.
  - Hang: ≤ 2 % for ≥ 0.5 s, inside the armed span, with throttle > 20 % within 1.5 s before **and** after (so ground idle before take-off, after landing or after a crash never counts) → `HANG TIME`.
  - Span events carry `end` (frame), `t0`, `dur`. The renderer shows a live timer `elapsed = clamp(frameTime − t0, 0, dur)` with ms, freezes and pops at the end, and keeps it 1.5 s (`SPAN_HOLD`). Active spans are looked up separately from `recent`, which only covers 2.5 s.
- `stats` holds per-frame cumulative arrays: `fullTotal`, `hangBest`, `armedTime`. The Stats readout (style key `stats`) shows a line once its value is > 0, and fades out while a popup or timer uses the space above the gimbals.

## Render model (`src/render/draw.ts`)

- **Pure per frame.** For frame `i` the renderer:
  - looks back over `recent` events (2.5 s window, binary search on the sorted events);
  - regenerates each particle from `rng(hash(spawnFrame, side, salt))`;
  - places it with an exact drag + gravity solution (`ballistic`).
  - Nothing is stored between frames.
- **Canvases per scene:** main ctx (given), `fx` (additive effects), `tint` (chroma and glitch scratch), `b1`/`b2` (1/4 and 1/16 downsamples for bloom).
- **Frame order:**
  1. Clear, plus the optional key background.
  2. Arm pop-in and shake transform (`hudT`).
  3. Base: plates, grid, crosshair, ring (circle, square, brackets; `ring:'rainbow'` = rotating conic gradient), throttle bar, readout, labels.
  4. FX on `fx` with `lighter`: trails (quadratic through midpoints; rainbow hue per spawn frame), halos, embers, flame, sparks, bursts, shockwaves.
  5. Composite fx: chromatic fringes (multiply-tinted copies offset ±d), then bloom (b1 and b2 upscaled with `lighter`).
  6. Crisp dots (circle or block cursor) and text (pop or terminal popups, throttle timers, stats readout).
  7. Glitch bands: copy to `tint`, then shift random horizontal bands on impacts.
  8. Scanlines: `destination-out` rows, which make the overlay itself striped.
- **Particle shapes:** `streak` (line from p(t−30 ms) to p(t)), `star` (4-point twinkle, slower, less gravity), `glyph` (katakana/0-1 characters that burst then rain down).
- **Scale:** layout is in output pixels; `scene.scale` maps to device pixels for preview. Line widths have a 1-device-px minimum.

## Layout (`src/render/layout.ts`)

- Gimbal box g = `size` × short side (default 0.17), r = 0.46 g. The HUD is two gimbals plus `gap` × g between them.
- Full frame: centred, with position bottom/middle/top (4 % margin), plus `offsetX/offsetY` × W/H.
- **Tight crop:** W = hud + 0.5 g each side; H = g + 1.05 g above (popups) + 0.4 g below (labels/readout). Sized by `cropRef`, the footage short side. Dimensions are always even.

## Video sync (`src/sync.ts`, `src/video.ts`)

- **Why phase correlation.** Intensity projections failed: the static analog OSD pins the estimate to zero, and the margins were about 0.008. Phase correlation on Hann-windowed 128×64 grey frames, with the zero-shift peak damped ×0.3, gives pan x ↔ gyro yaw r ≈ 0.8 on the real session.
- **FFT.** An in-house iterative radix-2 complex FFT, applied to rows then columns. Sub-pixel peak by parabola. Rates = shift / dt between frame timestamps, so VFR is handled.
- **`findOffset`** works on a 30 Hz grid:
  - Video pan x/y are clipped at 6 × the 90th percentile.
  - Score per lag = 0.7·|ncc(pan x, gyro yaw)| + 0.3·|ncc(pan y, gyro pitch)|. Absolute values, because camera mounting decides the signs.
  - The lag search requires an overlap of at least min(20 s, 60 % of the flight).
  - Returns `offset` (log = video + offset), `score`, `margin` (best − best peak more than 1 s away) and the full curve.
- **UI policy.** Auto-sync tries every flight of at least 4 s and picks by score × (0.5 + margin).
  - Margin below 0.06 is reported as "no confident match".
  - The confidence label is high when margin > 0.2 and r > 0.4, medium when margin > 0.1, else low.
  - The flow is cached on the `VideoInfo`, so switching flights re-matches instantly.
- **Cost:** about 3.7 s of JS for 6275 frames. In the browser, about 17 s end to end for a 3-minute 640×480 video, including decode.
- **fps:** `computePacketStats(300).averagePacketRate`, snapped to the **nearest** standard rate within 1.5 % (exact 1001 fractions), else rounded to 0.01.

## DVR clean pass (`src/clean/`)

Optional pre-pass, a port of FPV DVR Cleaner (https://github.com/Bratwurstexe/FPV_DVR_CLEANER) @ `264d232` (MIT; Python/OpenCV there, pure TS here): `analog.py` → `analog.ts`, `digital.py` → `hdzero.ts`, `osd.py` → `osd.ts`, the 100 % path of `upscale.py` → `fuse.ts`. Fix logic bugs upstream first, like the decoder.

- **Never inside `renderFrame`.** The repairs need neighbouring frames, and Mediabunny's `Conversion.process` has no lookahead. Cleaning produces a new input video, or feeds the burn-in encoder directly; the render model and determinism are untouched.
- **Ops** (`image.ts`) follow OpenCV semantics: BGR↔YCrCb with uint8 rounding, INTER_AREA/LINEAR/NEAREST, `blur` and `GaussianBlur` with REFLECT_101 (fixed kernels for k ≤ 7 when sigma = 0, k = round(8σ+1)|1 for floats), rect `dilate`, `remap` linear with replicate border, and truncation where the original does `astype(uint8)`. `osd.ts` carries its own Sobel, binary morphology, connected components, contour fill and a Telea-style inpaint (replacement for `cv2.inpaint`, within 0.2 levels of it on the same input).
- **Flow** (`flow.ts`): DIS-fast-like. Pyramid by INTER_AREA halving, coarsest = round(log2(2w/32)), finest scale 2, 8×8 patches with stride 4 (last patch flush with the edge), mean-normalised inverse-compositional Gauss-Newton (2 sweeps × 8 iterations with forward/backward spatial propagation), densified with weight 1/max(1,|I1(x+u)−I0(x)|), no variational refinement. Weaker than upstream's DIS near static overlays and at frame edges; that is the main source of the parity gaps below.
- **Options** (`CleanOptions`): `kind` (analog | hdzero), `amount` (colour calming or breakup level, 0 = stage off), `denoise` 0..100 (`calm = denoise/100`, lift fixed at 15/50), `osd`, `damageOnly`.
- **Chain** (`repair.ts` `repairChain`, `frames.ts` `runChain`): stages in upstream order (`restoration._stages`): colour or breakups → OSD → fusion. Each stage reads the previous stage's output over the range widened by the later stages' radii, so with `chainRadius(o)` context frames a chunk equals one pass over the whole stream (tested, also with OSD). Radii: analog 6 with the wide window (3 without), hdzero 3, OSD 4, fusion 2.
- **Analog deviations from upstream** (switchable through `tuning.adaptiveWindow` for parity runs): where neighbour colour support stays < 0.5 after ±3, re-estimate with frames out to ±6, so a dropout lasting several frames gets colour instead of grey. **Damage-only**: a cheap per-frame check (rows that lost colour their neighbours have, new hue tears, unbacked bands > 2 % of the grid) returns undamaged frames untouched before any flow; on real footage it repaired exactly the 7 visibly damaged frames of 24, at ~15 ms/frame.
- **OSD** (`osd.ts`): `findOsd` on 40 frames spread evenly over the cut (full frame), then `cropOsd` to the picture box. Removal is a range function, not a window one: whether an element is on screen depends on up to `HOLD` = 150 earlier frames. `pool.ts` feeds every decoded frame to an `OsdTrack` on the main thread, in order, and sends each chunk `track.state(lo + osdInputStart(o, from − lo))`, the history before the first frame the OSD stage receives. Moving OSD parts (artificial horizon) and small static objects in a still scene behave as upstream (not removed / taken for OSD).
- **Pool** (`pool.ts`, `worker.ts`): decode the cut ± (chainRadius+1)/fps with `VideoSampleSink`; each sample becomes a `VideoFrame` transferred to a worker (a clone when a neighbouring chunk on another worker also needs it), drawn and read back there, cropped to the picture box. Chunks of max(24, 4·radius) frames; at most 12 workers (the repair is memory-bound: per-frame cost 180 → 510 ms from 6 to 22 workers). Decoding pauses while every worker is repairing, and workers yield (`setTimeout(0)`) before each repair so Chrome can free decoder buffers (without it: 3–4 s decode stalls per chunk). A per-phase timing summary logs in dev.
- **Output:** `VideoSampleSource` H.264 `QUALITY_VERY_HIGH`, each frame with its **source timestamp − cut start** (VFR kept; checked frame for frame). Written through `StreamTarget` to OPFS (`stickcam-clean/`, `fastStart: false`), `BufferTarget` when OPFS is missing. Cache key = file name, size, mtime, cut and options; a repeat returns the file at once (`cached: true`). Audio packets of the cut are copied (`cutAudio`) when MP4 can hold the codec; packets starting before the cut are dropped.
- **Clean while burning** (`exportBurned` with `job.clean` and `job.video.info`): `cleanFrames` → overlay composited with the same frame-index rule → one H.264 encode, audio copied. Without `clean`, the `Conversion` path is unchanged.
- **Swap** (`repair.ts` `toCleaned`/`toOriginal`, `useCleaned`/`useOriginal` in `main.ts`, key `C`): clip time 0 = original cut start, so `offset += cutStart`, trim = [0, clip duration]; back restores the exact original cut if the trim wasn't touched.
- **Breakup scan** (`detect.ts`, `video.ts` `scan`): every frame at 160×120 in the same decode as the auto-sync motion pass (both through the public `drawWithFit`), `scoreFrame` (dropout, tears, row-direction confetti, ~0.25 ms) and `breakups` (each frame against the cleanest neighbours within ~0.5 s) → strength 0..1, cached on `VideoInfo.damage` with the picture box. Drives the timeline markers, Auto (`guessFromScores`: shape first, colour dropouts turn 16:9 into analog; "looks clean" when no strong breakup), and **signal glitch**: `Scene.breaks[i]` per output frame (built once in `sceneFor`), added to the glitch layer as `1.5·breaks[i]·signalGlitch·chaos`; on in hacker (1), synthwave (0.8), arcade (0.6).
- **Parity** (`scripts/clean-parity.ts` + `clean_ref.py`, 24 real 640×480 frames, balanced settings): colour 45–50 dB; breakups 35.5 dB (27.5 vs Python's 27.7 dB against the clean frames); fusion 31 dB, 51 dB with identical zero flow in both engines (the gap is the flow; upstream's own presets differ by ~33 dB); OSD mask IoU 1.0 and identical guide on two clips, refill 32–36 dB in the changed area.
- **Cost** (single-threaded, 640×480, ms/frame): colour 100–115, damage-only 15–45, breakups 27–37, OSD 135–190, fusion 85–100. In Chrome on 24 cores: colour only ~1 s per 1.3 s of 30 fps footage; colour + OSD + denoise ~3.8× real time.
- **Limit:** chroma is repaired on a grid of every 4th column and every 2nd row, so a hue that flips on every single pixel row can't be removed, in the original either.

## Export (`src/export/export.ts`)

- **webm/mp4:** `Output` + `CanvasSource` (Mediabunny), `QUALITY_HIGH`, keyframe every 2 s.
  - WebM: `codec:'vp9', alpha:'keep'`; Mediabunny writes the alpha side data as BlockAdditions.
  - MP4: `avc` with the key colour painted as background.
- **prores:** ffmpeg.wasm.
  - Frames go to PNG with `convertToBlob`, in chunks of about 2 s.
  - Each chunk runs `prores_ks -profile:v 4444 -pix_fmt yuva444p10le -alpha_bits 8 -qscale:v 9`, then `concat -c copy`.
  - Abort calls `ff.terminate()` and resets the singleton.
- **burn:** `Conversion.init({ trim, video: { process } })` (Mediabunny).
  - `process` draws the decoded sample with `drawWithFit(fill)`, renders the overlay to a second canvas and composites it.
  - Overlay frame index = round((sampleTs − base) × fps), where `base` is detected from the first sample (trim-relative or absolute).
  - No audio codec is forced, so the source audio is copied.
- **Capabilities:** `canEncodeVideo` probes, cached per size and fps; the Export button is disabled with an explanation when unsupported.

## UI state (`src/main.ts`)

- `S` holds file/flights, `data` (current FlightData), `full` (whole flight at 30 fps for the timeline), `cur` (trimmed track and motion at the output fps), `scene`, `trim`, `frame`, `video`, `offset`, preset and overrides, settings, `sizeId` (`'video'` = match video), `format`.
- Rebuild chain:
  - Settings that change the data (fps, mode, trim, offset, flight) → `rebuildCur()` (track + motion) → `rebuildScene()` → `draw()`.
  - Style and layout changes only call `rebuildScene()`, debounced 30 ms.
- **Timeline with a video:** the top 58 % is the flight lane (drag = shift offset, live), the bottom is the video lane (scrub, trim handles). Without a video it is a single lane.
- **Playback with a video:** the `<video>` element drives the frame through rAF reading `currentTime`, and loops within the trim. Scrubbing seeks the video.
- **Sky preview background** (`updateSky` in `main.ts`): a DOM layer under the preview canvas, never exported. While playing (no video, not reduced-motion) it banks with roll (32° at full stick) and shifts with pitch, using the mean stick over the last 0.3 s, a pure function of the frame. Paused, it eases back to level through a CSS transition.
- **URL hash** holds base64 JSON `{p, o, s:{mode,size,gap,position,chaos,fps,offsetX,offsetY}, z, f, c:{k, a, d, o, x, b}}` (`c` = clean kind, strength, denoise, remove OSD, damage only, clean while burning; older hashes still load).
- **`S.clean`:** kind, amount, `original`/`cleaned` VideoInfos, `shift` (cut start of the clean) and `cut`. `dropCleaned()` on load or remove of a video revokes both URLs.
- **User presets** (`src/presets.ts`): a `Look` is `{presetId, overrides, settings:{mode,size,gap,position,chaos,offsetX,offsetY}}`, i.e. the hash minus fps, size and format (those follow the footage). Stored as a `UserPreset[]` under localStorage `stickcam.presets.v1`. Export file: `{app:'stickcam', kind:'presets', version:1, exported, presets}`. Everything read back (storage or file) goes through `sanitizeLook`: unknown base preset → arcade, override keys/types checked against the built-in `Style`, settings defaulted. Import: `planImport` marks each incoming look new / same / conflict by case-insensitive name; identical looks are skipped silently, and only conflicts open the dialog. The card matching the on-screen look is highlighted (`markUserPresets`, called from `saveHash`).

## Verified facts (keep in mind)

| Fact | How verified |
|---|---|
| WebM alpha survives: `alpha_mode=1`, transparent corners after `libvpx-vp9` decode | ffprobe + PIL, 2026-10-03 |
| ProRes is `prores` 4444, `yuva444p12le` on decode, all frames present | ffprobe |
| Burned-in frame equals separate overlay composited on the source (mean diff 2.6/255) | ffmpeg overlay vs export |
| Synced overlay length equals video length (189.207 s vs 189.202 s) | ffprobe |
| Auto-sync: flight 1 at 88.92 s, flight 3 at 144.01 s (OSD truth ≈89 / 144) | browser + Node |
| Linux Chrome: `canEncodeAudio('aac') === false`, `opus === true` | in-page probe |
| Non-square-pixel DVRs display at odd sizes (720×486 SAR 8:9 → 720×547); `openVideo` rounds width/height down to even so H.264 burn-in and clean can encode | burn + clean of `deadprop.mp4`, 2026-10-23 |
| Cleaned clip keeps every source frame and timestamp (1454 frames, max Δt 16 µs); swap keeps the OSD frame at the same log time | ffprobe, 2026-10-23 |

## Flight controller logging (what StickCam needs)

- **Minimum fields:** RC commands (sticks + throttle → overlay) and filtered gyro (flip/roll/spin integration in `motion.ts`, pan↔gyro correlation in `sync.ts`). Armed state comes from the S-frames, which are always logged. Motors only feed a hint (`motorMean`, falls back to throttle). Everything else is optional.
- **Rate:** 1/16 of the PID loop (250 Hz at 4 kHz) is plenty for 30-60 fps output; 1/8 for faster tricks.
- **Wire:** `MSP_BLACKBOX_CONFIG` (80) / `MSP_SET_BLACKBOX_CONFIG` (81) carry device, rate index and, from API 1.45, a u32 *disabled* mask (bit set = field off). Bit order per API: PID, RC, setpoint, battery, mag, alt, RSSI, gyro, [attitude ≥1.47], acc, debug, motor, GPS, RPM, gyro-unfiltered, [servo ≥1.47], [pitot ≥1.49]. Persist with `MSP_EEPROM_WRITE` (250). Always read-modify-write.
- **Estimate:** `estimate()` in `blackbox.ts` is a rough per-field byte model (default config ≈ 7 min, StickCam ≈ 140 min in 16 MB at a 4 kHz loop). Recalibrate against a real log once one exists.
