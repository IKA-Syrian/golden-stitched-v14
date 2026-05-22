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

### How it works

1. Load images (natural sort) and normalize them to a common width.
2. For each consecutive pair, detect the vertical overlap and trim the duplicate.
   A detected overlap is only trimmed if it passes three gates: the bands are
   near-identical (pixel MAD), the band has real content (std-dev floor), and the
   match is unique (not one of many equally-good flat alignments).
3. Concatenate into one strip and slice into ~`height` pages, cutting on blank
   rows (SmartStitch-style) so panels and speech bubbles aren't split.

Tuning knobs (slicing sensitivity, and the overlap MAD / variance / uniqueness
thresholds) are CLI flags on `smart_stitch.py` — run `py -3 smart_stitch.py -h`.
