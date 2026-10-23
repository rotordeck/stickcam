# StickCam: notes for picking this up again

A static web app that turns a **Betaflight blackbox log** (`.bbl`/`.bfl`) into a **stick-cam overlay video**. The looks run from a clean white dot to fully over the top: sparks, shockwaves, trick combos, flames, glitches, rainbows. You can also add your **FPV video**: the app auto-syncs it to the log and exports either an overlay matching the video's size, frame rate and length, or the **cut video with the sticks burned in**.

Everything runs in the browser. No server, and the user's log and video never leave their machine. Output is a static `dist/`.

Owner: Hans (HansF). Started 2026-10-03 as a spin-off of `~/Projects/fpvstream`, whose decoder and sticks overlay it reuses.

## Commands

```sh
npm install
npm run dev        # Vite dev server (the author uses --port 5199); opens on the Freestyle demo
npm test           # vitest: decoder, track, motion events, layout, flow/sync, fps snapping, FC, logging settings, user presets, DVR clean (54 tests)
npm run build      # tsc --noEmit + vite build → dist/ (≈2 MB incl. samples). BASE=/sub/ for sub-path hosting
npx tsc --noEmit   # typecheck only
node scripts/make-samples.ts   # re-cut public/samples/*.bbl from the real logs (needs ../fpvstream + ../betamcp)
```

Node 26 runs the `.ts` modules directly (type stripping). For that reason:

- Imports between our TS files use the `.ts` extension (`allowImportingTsExtensions`).
- **No TS-only runtime syntax.** `erasableSyntaxOnly` is on: no parameter properties, no enums.

## Map

| File | What it does |
|---|---|
| `src/decoder/bbl.js`, `units.js` | **Unchanged copies** of fpvstream `viewer/src` @ `8eb4661`, plus hand-written `.d.ts`. Fix decoder bugs upstream first, then re-copy. |
| `src/track.ts` | Resamples a flight to the output fps. Sticks: roll/pitch/yaw = rcCommand/500 (±1), throttle 0..1. `live=0` in log gaps. Armed span comes from S-frame flags. Port of Android `StickTrack.kt`. |
| `src/motion.ts` | Stick speeds and **events**: snap, punch, flip/roll/spin (integrated full-rate gyro), combo, crash ("WASTED"), arm/disarm, **full throttle** ("FULL SEND") and **hang time** spans timed to the ms from the full-rate throttle, and cumulative `stats` (full-throttle total, longest hang, armed time). No score: every number on screen is measured. Pure. |
| `src/render/draw.ts` | `renderFrame(ctx, scene, i)` is **a pure function of the frame index**. Layers: base → additive fx canvas → chroma/bloom → crisp dots/text → glitch → scanlines. |
| `src/render/style.ts` | The `Style` type and **8 presets**: clean, minimal, neon, arcade, synthwave, inferno, unicorn, hacker. |
| `src/render/layout.ts` | Output sizes, gimbal placement (17 % of the short side, as in `StickHud.kt`), tight crop, X/Y nudge. |
| `src/export/export.ts` | `webm` (VP9 + alpha), `mp4` (H.264 on a key colour), `prores` (ffmpeg.wasm), `burn` (cut video + overlay + audio). |
| `src/sync.ts` | `FlowEstimator`: FFT phase correlation on 128×64 frames gives pan x/y per frame. `findOffset` cross-correlates it with the gyro. Pure. |
| `src/video.ts` | Opens the video with Mediabunny (size, fps snapping, duration) and runs the motion pass through a `CanvasSink`. |
| `src/fc/fc.ts`, `huffman.ts` | **Read the log off the whoop**: WebSerial + minimal MSP v1 client (jumbo frames), `MSP_DATAFLASH_SUMMARY`/`READ` loop with Huffman decompression, 4096-byte blocks, retry on CRC/timeout. Ported from betaflight-configurator (`MSPHelper.dataflashRead`, `useDataflashPull.js`); the tree is a verbatim copy. Flash only: SD-card logs can't be read over MSP. Also the blackbox config calls (`apiMinor`, `getBlackboxConfig`, `setBlackboxConfig` = set → EEPROM write → read-back, `eraseFlash`). Erase: some flash chips make the FC stop answering MSP while erasing, so `eraseFlash` waits up to 60 s for the MSP 72 reply and treats poll timeouts as busy until a 180 s deadline, as the configurator does (a 5 s timeout failed on real hardware). |
| `src/fc/blackbox.ts`, `dialog.ts` | **Logging settings** (pure): field table with the disabled-mask bit order per API version, config codec (MSP 80/81), profiles (StickCam = RC+gyro @1/16, Balanced @1/8, Betaflight default), size estimate, diff text, CLI commands. `dialog.ts` is the "Logging settings…" dialog (own serial connection while open; previous settings kept in localStorage for "Restore previous"; erase only after a full download this session, double-click confirm). |
| `src/presets.ts` | **User presets (saved looks)**, pure: a look = base `presetId` + Tweak `overrides` + gimbal settings (mode, size, gap, position, chaos, offsets); output size/fps/format are deliberately left out. localStorage key `stickcam.presets.v1`, JSON file `{app:'stickcam', kind:'presets', version:1, presets}`, sanitizing, import plan (new / identical / name clash, case-insensitive) and apply (skip / add / overwrite / keep both → "Name (2)"). UI in `main.ts` (section "4 · Presets", dialog `#upDlg`). |
| `src/clean/` | **Optional "Clean DVR" pre-pass**, a browser port of [FPV DVR Cleaner](https://github.com/Bratwurstexe/FPV_DVR_CLEANER) @ `264d232` (MIT): `analog.ts` (colour dropouts, rainbow tears, unbacked bands; port of `analog.py`), `hdzero.ts` (breakup/confetti repair; `digital.py`), `image.ts` (OpenCV-semantics plane ops), `flow.ts` (DIS-fast-like dense flow), `frames.ts` (±3-frame windows), `repair.ts` (dispatch, black-bar box, kind guess, offset shift on swap; pure), `worker.ts` + `clean.ts` (Mediabunny decode → worker pool → H.264 with source timestamps and copied audio; one-frame before/after). UI in `main.ts` (`renderCleanBar`, `#cmp` overlay). |
| `src/demo.ts` | Synthetic freestyle flight, scripted so every effect fires (tests rely on its event list). |
| `src/main.ts` | The whole UI: state `S`, loading, timeline, playback, sync bar, presets, tweak panel, export dialog, dev hook. |
| `index.html`, `src/style.css` | Layout: left panel (log → style → tweak → export), right stage + transport + sync bar + timeline. |
| `public/samples/` | Three short real-log clips + `samples.json` (the author's own flights; the repo is private). |
| `scripts/make-samples.ts` | Cuts the sample clips: original header + a byte slice of data. The decoder resyncs on the next I-frame. |
| `test/` | `clean.test.ts` (image ops, flow, windows, HDZero and analog repairs on synthetic footage, bar box, swap), `pipeline.test.ts` (decoder/track/motion/layout), `sync.test.ts` (flow, synthetic-video auto-sync, fps), `fc.test.ts` (fake FC: download raw/Huffman/corrupt frame, config write, erase), `blackbox.test.ts` (mask order, codec, profiles, estimate), `presets.test.ts` (file round trip, sanitizing, import plan/apply). |

Read `docs/architecture.md` for the design detail: clocks, render model, sync algorithm, export pipelines, verified facts.

## Rules that keep it working

- **Determinism.** Rendering must stay a pure function of `(scene, frameIndex)`: particles are regenerated from `hash(spawnFrame, …)` and integrated analytically. No per-frame mutable simulation state, otherwise preview, seek and export drift apart.
- **The clock.** With no video, the timeline is flight time. With a video, the **video is the master clock**: trim and playhead are in video seconds, and `logTime = videoTime + S.offset`. `S.trim` is always in timeline-axis seconds; `buildTrack(data, fps, trim0 + off(), trim1 + off())`.
- **Throttle range.** BF4+ logs have **no `minthrottle` header**, and rcCommand[3] runs 1000..2000. `parseHeader`'s 1150 default is wrong for throttle, so use `throttleRange(raw)`.
- **Audio.** Never force an audio codec in Mediabunny conversions. Linux Chrome can't encode AAC through WebCodecs (Opus only). Leaving it unset copies the source audio.
- **ffmpeg.wasm.** Single-thread core loaded from jsDelivr (`@ffmpeg/core@0.12.10`) with `toBlobURL`. It needs no COOP/COEP headers, and plain static hosting works.
- **Fonts.** Canvas text needs fonts loaded before the first render. They are bundled through @fontsource (Bungee, Orbitron 900, VT323, Fredoka 700) and awaited at boot. Linux has no Impact.
- **DVR clean is a pre-pass.** It produces a new input video and never runs inside `renderFrame`. The cleaned clip starts at the cut start: swapping adds the cut start to `S.offset` (`toCleaned`/`toOriginal`). The `src/clean/` repairs are ports: fix logic bugs upstream in FPV DVR Cleaner first and keep the port in step (note the commit in the file headers).
- **Popup labels.** Presets can rename them with `labelMap` (e.g. WASTED → "OOPSIE!" / "FATAL ERROR: CRASH").
- **Dev hook.** Test exports with it, not with browser downloads. In `npm run dev`, `window.__stickcam` offers:
  - `exportTo(fmt, name)`: writes `.dev-out/<name>.<ext>` through the `/__dev/save` middleware in `vite.config.ts`.
  - `loadUrls(logUrl, videoUrl)`, `set({preset,size,fps})` and `S`.
  - `clean(kind?, amount?)`: runs the DVR clean on the current cut and swaps the clip in; `useOriginal()` / `useCleaned()`.
  - Check outputs with `ffprobe` (WebM alpha → `TAG:alpha_mode=1`).
- **Test data** is git-ignored and lives outside the repo. Copy it into `.dev-out/` (also ignored) to serve it from the dev server:
  - `~/Projects/fpvstream/flightdata/20261001/blackbox_20261001_105759.bbl`: 3 flights, 45.3 s / 2.2 s / 24.9 s.
  - `~/Projects/fpvstream/flightdata/20261001/session_20261001_105305/fpv.mp4`: 640×480, VFR ~54 fps (by packet rate), 189.2 s, **no audio**.
  - Ground truth from the OSD arm timer: flight 1 starts at **88.9 s** in the video, flight 3 at **144.0 s**. Auto-sync gives 88.92 / 144.01.
  - All real logs on this machine are gentle indoor whoop flying with no flips. Trick effects are exercised by `src/demo.ts`.

## Status (2026-10-03)

Done and verified in Chrome and with ffprobe:

- "Read from flight controller" button (Chrome/Edge/Opera only): downloads the onboard flash over USB, loads it, and offers "Save .bbl". **Only tested against a fake FC, not real hardware yet.** "Logging settings…" dialog writes the blackbox field mask and rate (StickCam needs only RC + filtered gyro; everything else wastes the 16 MB flash). The mask bit order comes from betaflight-configurator and is verified by read-back only: check once with `diff` in the CLI on a real board.
- Log loading (multi-flight, legacy-dump repair), demo, 3 real sample clips.
- 8 presets with live thumbnails. The Tweak panel covers chaos, colours, every effect, frame shape, particle shape, mode 1/2, size, spacing, position and X/Y nudge. Settings are kept in the URL hash.
- Grounded effects: the made-up score is gone. Live timers with milliseconds for full throttle (≥ 98 %, ≥ 0.3 s) and hang time (armed, zero throttle ≥ 0.5 s mid-flight), a pulsing hot throttle ring and harder flame at full throttle, and a "Stats" readout (FULL THR / HANG MAX / ARMED) that steps aside while a popup or timer is up. The demo has two full-throttle spans and one hang.
- Sky preview background flies with the sticks while playing (horizon banks and pitches; preview only).
- Presets section: save the current look under a name (kept in localStorage, live thumbnails, click to apply, Update/Rename/Delete), export all to a JSON file, import with a clash dialog (Overwrite all / Keep mine / Choose per look with Overwrite or Keep both).
- Timeline with activity, throttle and event markers, trim handles, scrub, playback, keyboard (space, ←/→, shift = 10 frames).
- Exports:
  - WebM VP9 alpha: 1080p30 20 s in 4.8 s.
  - ProRes 4444: 8-bit alpha, chunked, ~12 s for a 20 s crop.
  - MP4 on black or green.
  - Burned-in: a 28 s cut in 2.5 s, audio copied.
  - All work from a plain `python -m http.server` of `dist/`.
- Video: preview behind the overlay, auto-sync over all flights, manual drag of the flight lane, ±1 frame / ±1 s nudges, "Trim to flight", "Whole video", remove.
- Output size and fps follow the video; the placement hint and the file name carry the start time when trimmed.

- Optional **Clean DVR** (2026-10-23): analog colour and HDZero breakup repair ported from FPV DVR Cleaner, with "Check frame" before/after and "Clean cut", which swaps in the cleaned clip keeping sync and cut. Real session: 48.8 s cut cleaned in 38 s, timestamps identical, burn-in from the cleaned clip OK, worker loads from a static `dist/`. Parity against the Python engine: analog 40–49 dB, HDZero the same blocks rebuilt. No HDZero footage on this machine: HDZero is tested on real analog frames with injected confetti only. Also run on three more analog DVRs in `~/Videos` (deadprop NTSC, bird PAL, outside 640×480); side-by-sides in `~/Videos/stickcam-clean/`. `VideoInfo` width/height are rounded down to even (odd non-square-pixel display sizes broke H.264 burn-in).

Not done, or open:

- Exported files haven't been opened in Premiere, Resolve or Final Cut yet. Only ffprobe and frame decoding were used.
- A user reported "weird lines" in one burned-in export. They turned out to be scanline rows, most likely a Scanlines override left on in Tweak; it was not reproduced as a bug.
- Big logs (16 MB+) decode on the main thread and freeze the page briefly. A worker would fix that.
- The video preview only shows when the output aspect matches the video ("Match video" size); in tight crop the preview is overlay-only.
- WebM alpha encode needs Chromium (Firefox and Safari lack VP9 alpha in WebCodecs). The UI disables unsupported formats.
- GitHub Pages workflow (`.github/workflows/pages.yml`) is manual-only (`workflow_dispatch`). Pages on a private repo needs a paid plan, so deploy elsewhere (Cloudflare Pages / Netlify: build `npm run build`, dir `dist`) or make the repo public.

Ideas backlog:

- Clean DVR phase 2: **OSD removal** (`osd.py`: clip-wide gradient-coherence mask, "only while shown" elements, refill from the best-fitting neighbour); it also feeds the `overlay` input of `analog.repairWindow`. Phase 3: multi-frame denoise + 1.5×/2× upscale (`upscale.py`), probably WebGL2.

- A freestyle log with real flips, to tune trick detection thresholds (`ROT_START`/`ROT_HOLD` in `motion.ts`).
- Rates/expo display: show setpoint deg/s using `RateCurve.kt` from fpvstream.
- More presets: an OSD-style DJI look, minimal broadcast, "retro handheld".
- Audio-reactive effects. Sound effects in the burned-in export.
- Sub-frame sync refinement. Show the correlation curve in the sync bar.
- A worker for decode and flow analysis. Bundled samples with matching video.
