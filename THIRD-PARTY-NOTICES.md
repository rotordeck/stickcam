# Third-party notices

## ffmpeg.wasm

The ProRes 4444 export path (`src/export/export.ts`) loads `@ffmpeg/core` 0.12.10 from jsDelivr at runtime
(https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10). The core is **GPL-2.0-or-later**, which is compatible with
StickCam's AGPL-3.0-or-later. The `@ffmpeg/ffmpeg` and `@ffmpeg/util` wrappers are MIT. The core is not bundled
with StickCam; it is fetched by the user's browser only when a ProRes export is started.

## mediabunny

Video demuxing and the MP4/WebM encoders use `mediabunny`, **MPL-2.0**. The file-level copyleft applies only to
modified files of that library.

## Fonts

`@fontsource/*` (Bungee, Fredoka, Orbitron, VT323) are SIL Open Font License 1.1.

## FPV DVR Cleaner

`src/clean/analog.ts`, `hdzero.ts`, `osd.ts`, `fuse.ts`, `frames.ts` and parts of `src/clean/repair.ts` are ports of
FPV DVR Cleaner (https://github.com/Bratwurstexe/FPV_DVR_CLEANER, commit `264d232`), `src/flugbild/analog.py`,
`digital.py`, `osd.py`, `upscale.py`, `pipeline.py` and `restoration.py`. `scripts/clean_ref.py` calls that engine for parity checks.

```
MIT License

Copyright (c) 2026 FPV DVR Cleaner contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
