"""Reference side of scripts/clean-parity.ts: runs FPV DVR Cleaner's own stages on raw frames.

    CLEANER_SRC=/path/to/FPV_DVR_CLEANER/src python -I scripts/clean_ref.py job.json

job.json: {"w", "h", "n", "stages": [{"name", "input", "output", ...}]}, frames as raw rgb24.
Stages: "colour" (analog.repair_stream, amount), "breakups" (digital.repair_stream, amount),
"fusion" (upscale.fuse_stream at 100 %, calm, lift), "fusion0" (the same with zero flow) and "chain" (colour, then fusion), all with
the desktop app's "balanced" effort (restoration.EFFORTS), as the TS port uses it.
Needs numpy and opencv-python(-headless). Writes the outputs as raw rgb24.
"""

import json
import os
import sys

src = os.environ.get("CLEANER_SRC")
if not src:
    sys.exit("CLEANER_SRC is not set")
sys.path.insert(0, src)

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from flugbild import analog, digital, upscale  # noqa: E402


def read(path, w, h, n):
    data = np.fromfile(path, np.uint8).reshape(n, h, w, 3)
    return [cv2.cvtColor(f, cv2.COLOR_RGB2BGR) for f in data]


def write(path, frames):
    with open(path, "wb") as out:
        for f in frames:
            out.write(cv2.cvtColor(f, cv2.COLOR_BGR2RGB).tobytes())


def colour(frames, s):
    # balanced: colour radius 3, flow 320 (the defaults)
    return analog.repair_stream(frames, s["amount"], None, 3, 320)


def fusion(frames, s):
    # balanced: radius 2, flow 400, DIS fast, linear warping
    return upscale.fuse_stream(frames, 100, s["calm"], s["lift"], 2, 400,
                               cv2.DISOPTICAL_FLOW_PRESET_FAST, cv2.INTER_LINEAR)


class _NoFlow:
    """Zero optical flow, so both engines warp identically and only the rest of the stage differs."""

    def calc(self, first, second, flow):
        return np.zeros((*first.shape, 2), np.float32)


def fusion0(frames, s):
    create = cv2.DISOpticalFlow_create
    cv2.DISOpticalFlow_create = lambda *_: _NoFlow()
    try:
        # fuse_stream is a generator; drain it while the stand-in is installed.
        return list(fusion(frames, s))
    finally:
        cv2.DISOpticalFlow_create = create


STAGES = {
    "colour": colour,
    "breakups": lambda frames, s: digital.repair_stream(frames, s["amount"]),
    "fusion": fusion,
    "fusion0": fusion0,
    "chain": lambda frames, s: fusion(colour(frames, s), s),
}


def main():
    job = json.load(open(sys.argv[1]))
    w, h, n = job["w"], job["h"], job["n"]
    for s in job["stages"]:
        out = list(STAGES[s["name"]](iter(read(s["input"], w, h, n)), s))
        assert len(out) == n, (s["name"], len(out))
        write(s["output"], out)


main()
