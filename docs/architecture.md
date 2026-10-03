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
- **Combo:** tricks less than 1.6 s apart chain. Points = 100 × turns × combo.
- **Crash:** an acceleration spike above 6 g in the 1.5 s before disarm. The card lands on the impact; otherwise a plain DISARMED.
- `score[i]` is cumulative. The renderer shows a 0.3 s moving average, so it counts up.

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
  6. Crisp dots (circle or block cursor) and text (pop or terminal popups, score, +points).
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
- **URL hash** holds base64 JSON `{p, o, s:{mode,size,gap,position,chaos,fps,offsetX,offsetY}, z, f}`.

## Verified facts (keep in mind)

| Fact | How verified |
|---|---|
| WebM alpha survives: `alpha_mode=1`, transparent corners after `libvpx-vp9` decode | ffprobe + PIL, 2026-10-03 |
| ProRes is `prores` 4444, `yuva444p12le` on decode, all frames present | ffprobe |
| Burned-in frame equals separate overlay composited on the source (mean diff 2.6/255) | ffmpeg overlay vs export |
| Synced overlay length equals video length (189.207 s vs 189.202 s) | ffprobe |
| Auto-sync: flight 1 at 88.92 s, flight 3 at 144.01 s (OSD truth ≈89 / 144) | browser + Node |
| Linux Chrome: `canEncodeAudio('aac') === false`, `opus === true` | in-page probe |

## Flight controller logging (what StickCam needs)

- **Minimum fields:** RC commands (sticks + throttle → overlay) and filtered gyro (flip/roll/spin integration in `motion.ts`, pan↔gyro correlation in `sync.ts`). Armed state comes from the S-frames, which are always logged. Motors only feed a hint (`motorMean`, falls back to throttle). Everything else is optional.
- **Rate:** 1/16 of the PID loop (250 Hz at 4 kHz) is plenty for 30-60 fps output; 1/8 for faster tricks.
- **Wire:** `MSP_BLACKBOX_CONFIG` (80) / `MSP_SET_BLACKBOX_CONFIG` (81) carry device, rate index and, from API 1.45, a u32 *disabled* mask (bit set = field off). Bit order per API: PID, RC, setpoint, battery, mag, alt, RSSI, gyro, [attitude ≥1.47], acc, debug, motor, GPS, RPM, gyro-unfiltered, [servo ≥1.47], [pitot ≥1.49]. Persist with `MSP_EEPROM_WRITE` (250). Always read-modify-write.
- **Estimate:** `estimate()` in `blackbox.ts` is a rough per-field byte model (default config ≈ 7 min, StickCam ≈ 140 min in 16 MB at a 4 kHz loop). Recalibrate against a real log once one exists.
