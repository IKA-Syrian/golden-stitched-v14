# golden-stitched-v14
A Discord stitching bot with Discord.js V14

Based on SmartStitch and gdrive and rclone library

## Smart stitch (overlap-aware)

`/stitch` takes an optional **`smart`** toggle:

- `smart:false` (or omitted) — original behavior, runs SmartStitch.
- `smart:true` — runs `smart_stitch.py`, which **detects and removes the
  duplicated band shared by overlapping screenshots** before stitching. Use this
  for phone screenshots of a scrolling webtoon, where each shot overlaps the next.
  When two images don't actually overlap it falls back to a plain join, so it's
  safe on normal chapters too.

Example:

```
/stitch link:<drive-url> height:20000 format:png smart:true
```

### Setup for smart mode

`smart_stitch.py` needs Python 3 with a couple of libraries:

```
py -3 -m pip install -r requirements.txt      # Windows
python3 -m pip install -r requirements.txt    # Linux/macOS
```

The bot picks the Python launcher automatically (`py -3` on Windows, `python3`
elsewhere). Override it if needed with the `PYTHON_BIN` environment variable, e.g.
`PYTHON_BIN="python"` or a full path to a venv interpreter.

On Linux servers with an externally-managed Python (you'll see
`error: externally-managed-environment`), install into a virtualenv and point the
bot at it:

```
python3 -m venv .venv         # or: uv venv
.venv/bin/python -m pip install -r requirements.txt   # or: uv pip install -r requirements.txt
echo 'PYTHON_BIN=/full/path/to/.venv/bin/python' >> .env
pm2 restart all --update-env
```

### How it works

1. Load images (natural sort) and normalize them to a common width.
2. For each consecutive pair, find the vertical overlap and trim that duplicate
   band. A real scroll-overlap matches pixel-for-pixel (MAD ≈ 0), so the detector
   picks the **largest overlap among the *tightest* matches** (within
   `--tight-margin` of the best MAD). This is the crucial bit: a slightly larger
   but *looser* alignment (similar-looking but not identical) must NOT win, or it
   trims across and deletes real content. A fast row-signature shortlist proposes
   candidates, confirmed on real pixels. If nothing matches, the images are
   butt-joined — so normal chapters (distinct panels) are safe too. A flat/white
   band (e.g. a shared speech bubble) is fine: if the pixels match, it's trimmed.
3. Feather each seam (a short cross-fade, `--feather` rows). In animated or
   gradient regions (sparkle/bokeh transitions) consecutive screenshots aren't
   pixel-identical, so a hard cut would leave a faint horizontal tonal step in
   the smooth area; the cross-fade spreads it out so it's invisible. For a
   perfectly-identical overlap this is a no-op.
4. Concatenate into one strip and slice into ~`height` pages, cutting on blank
   rows (SmartStitch-style) so panels and speech bubbles aren't split.

Tuning knobs are CLI flags on `smart_stitch.py` (run `py -3 smart_stitch.py -h`):
- `--tight-margin` (default 1.0) — how far above the best (lowest) overlap MAD
  still counts as a match. Smaller = more conservative (never deletes content,
  may leave a tiny repeat); larger = trims more aggressively.
- `--mad-accept` — an overlap is rejected outright if its MAD exceeds this.
- `--feather` — seam cross-fade height (`0` disables it).
