# StickCam

Turn a Betaflight blackbox log into a stick-cam overlay video, from a clean white dot to completely over the top: sparks on fast stick moves, shockwaves on full-deflection snaps, combo popups on flips and rolls, afterburner flames on punch-outs, and a WASTED card when you crash.

Everything runs in the browser. The log never leaves your machine, and the site is plain static files.

## Use it

1. Drop a `.bbl`/`.bfl` log, or pick a sample. Multi-flight files show a flight list.
2. Pick a style and tweak it. Chaos scales every effect, and the settings live in the URL hash, so a link shares your look.
3. Drag the timeline handles to trim. The default is the armed span plus a short outro.
4. **Optional: add your FPV video** (drop it with the log, or use "+ Add your FPV video").
   - It plays behind the overlay. **Auto-sync** matches the camera motion (phase-correlation optical flow) against the gyro of every flight in the log, then picks the flight and the offset.
   - To fix it by hand, drag the flight lane on the timeline or use the ±1 frame / ±1 s nudges.
   - Output size and frame rate switch to the video's, and the overlay covers the whole video, so you can drop it at 0:00. Use "Trim to flight" to cut it down; the hint then tells you where to place it.
   - **Cut video + sticks burned in** exports the trimmed video with the overlay drawn in, plus its audio, as a ready-to-post MP4.
5. Export:

| Format | Transparency | Best for |
|---|---|---|
| WebM VP9 | yes (alpha) | DaVinci Resolve, Kdenlive, Shotcut, CapCut desktop. Fast, small. Needs Chrome or Edge to encode. |
| ProRes 4444 `.mov` | yes (alpha) | Premiere, Final Cut, After Effects, Resolve. Encoded with ffmpeg.wasm, which loads once from jsDelivr (~30 MB). Big files. |
| MP4 on black | no | Any editor, including phone apps: set the blend mode to Screen or Add. Glow styles look best this way. |
| MP4 on green | no | Chroma key. Glow keys out poorly. |
| Cut video + sticks (MP4) | n/a, burned in | Posting straight away. Only offered when a video is loaded. |

**Tight crop** renders only the HUD plus room for effects, which is much faster and smaller; you position it in your editor. Pick the footage height it is meant for, so the gimbals come out at the right pixel size.

## Develop

Resuming work? Start with [`CLAUDE.md`](CLAUDE.md) and [`docs/architecture.md`](docs/architecture.md).


```sh
npm install
npm run dev      # http://localhost:5173
npm test         # vitest: decoder, track, motion events, layout
npm run build    # static site in dist/ (BASE=/sub/path/ npm run build for a sub-path)
```

Layout:

- `src/decoder/`: `bbl.js` and `units.js`, copied unchanged from fpvstream `viewer/src`. Fix decoder bugs there first, then re-copy.
- `src/track.ts`: the flight resampled to the output fps, sticks normalised (-1..1, throttle 0..1), and gaps marked as not live.
- `src/motion.ts`: stick speeds and events (snap, punch, flip/roll/spin from the integrated full-rate gyro, combo, crash, arm/disarm, score).
- `src/render/`: `draw.ts` renders a frame as a pure function of the frame index. Particles are regenerated from a seeded hash of their spawn frame, so preview, seek and export always match. `style.ts` holds the presets and `layout.ts` the sizes.
- `src/export/export.ts`: WebCodecs + Mediabunny for WebM and MP4, and ffmpeg.wasm for ProRes (PNG chunks → `.mov` chunks → concat).
- `src/sync.ts`: global camera motion by FFT phase correlation (128×64 frames) and the offset search against the gyro. `src/video.ts` opens the video with Mediabunny and runs the motion pass.
- `src/demo.ts`: a synthetic freestyle flight that fires every effect.
- `public/samples/`: short real-log clips, cut by `node scripts/make-samples.ts`.

In `npm run dev`, `window.__stickcam.exportTo(format, name)` exports without a download prompt and writes the file to `.dev-out/` for checks with `ffprobe`.
