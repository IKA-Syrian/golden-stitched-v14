#!/usr/bin/env python3
"""
smart_stitch.py - overlap-aware webtoon / manga stitcher.

WHY THIS EXISTS
---------------
SmartStitch (https://github.com/MechTechnology/SmartStitch) blindly concatenates
every input image end-to-end, then slices the long strip back into pages on blank
rows. That is perfect when each input is a *distinct* slice of artwork. It is wrong
when the inputs are phone SCREENSHOTS of a scrolling webtoon, because consecutive
screenshots share an identical band of pixels (the part that was visible in both
frames). Naive concatenation duplicates those bands and the comic "stutters".

This script adds the missing step: for every consecutive pair it DETECTS the shared
vertical band, removes the duplicate, and only then concatenates + slices. When two
images do NOT overlap (normal chapter, or a gap between screenshots) it falls back
to a plain butt-join, so it is safe to use on ordinary chapters too.

PIPELINE
--------
  1. Collect image files (natural sort, like SmartStitch's natsort).
  2. Normalize every image to a common width (min width, or --width).
  3. For each consecutive pair: detect overlap -> trim duplicate, else butt-join.
  4. Concatenate into one tall strip.
  5. Slice into pages near --split-height, cutting on blank rows (SmartStitch-style).
  6. Save pages to --output in --format.

Dependencies: numpy, Pillow.
"""

import argparse
import os
import re
import sys

import numpy as np
from PIL import Image

# Pillow >= 9.1 moved the resampling enum; support both.
try:
    RESAMPLE_LANCZOS = Image.Resampling.LANCZOS
except AttributeError:  # pragma: no cover - older Pillow
    RESAMPLE_LANCZOS = Image.LANCZOS

IMAGE_EXTS = (".png", ".webp", ".jpg", ".jpeg", ".jfif", ".bmp", ".tiff", ".tga")


# --------------------------------------------------------------------------- #
# File discovery & ordering
# --------------------------------------------------------------------------- #
def natural_key(name):
    """Sort key so '2.png' < '10.png' (natural / human ordering)."""
    return [int(t) if t.isdigit() else t.lower()
            for t in re.split(r"(\d+)", name)]


def collect_images(input_dir):
    """Return image paths in natural order.

    Prefers images sitting directly in `input_dir`. If there are none, descends
    into the subdirectory that holds the most images (handles the common
    "downloaded a folder that contains one chapter folder" case).
    """
    def images_in(d):
        return [os.path.join(d, f) for f in os.listdir(d)
                if f.lower().endswith(IMAGE_EXTS)
                and os.path.isfile(os.path.join(d, f))]

    direct = images_in(input_dir)
    if direct:
        return sorted(direct, key=lambda p: natural_key(os.path.basename(p)))

    best_dir, best_count = None, 0
    for root, _dirs, files in os.walk(input_dir):
        count = sum(1 for f in files if f.lower().endswith(IMAGE_EXTS))
        if count > best_count:
            best_dir, best_count = root, count
    if best_dir is None:
        return []
    return sorted(images_in(best_dir),
                  key=lambda p: natural_key(os.path.basename(p)))


# --------------------------------------------------------------------------- #
# Overlap detection
# --------------------------------------------------------------------------- #
class OverlapParams:
    """Tunable knobs for the detector. Defaults suit clean PNG/JPEG screenshots."""
    def __init__(self, args):
        self.min_overlap = 8                     # ignore matches smaller than this (px)
        self.max_overlap_frac = 0.92             # never trim more than this fraction
        self.ignore_side = args.ignore_side      # cols skipped left & right
        self.mad_accept = args.mad_accept        # an overlap is invalid if pixel MAD > this
        self.tight_margin = args.tight_margin    # how far above the best MAD still counts as "tight"
        self.coarse_accept = args.coarse_accept  # row-signature score to shortlist candidates
        self.coarse_tight = 5.0                  # keep candidates within this of the best coarse score
        self.coarse_scale = 2                    # row-signature downscale for the coarse search
        self.max_checks = 120                    # cap candidate pixel-checks per pair


def _row_signature(gray, ignore_side, buckets=16):
    """Per-row fingerprint: each row reduced to `buckets` column-averages.

    A single per-row mean is too weak -- many unrelated rows share a brightness,
    so misaligned offsets score deceptively low and crowd out the true overlap.
    Splitting each row into a few horizontal buckets stays cheap but captures
    enough structure that essentially only the correct alignment scores low.
    """
    interior = gray[:, ignore_side: gray.shape[1] - ignore_side] if ignore_side else gray
    w = interior.shape[1]
    if w < buckets * 2:
        return interior.mean(axis=1, keepdims=True)
    edges = np.linspace(0, w, buckets + 1).astype(int)
    sig = np.empty((interior.shape[0], buckets), dtype=np.float32)
    for b in range(buckets):
        sig[:, b] = interior[:, edges[b]:edges[b + 1]].mean(axis=1)
    return sig


def _refine(up, lo, side, ov0, s, max_ov, min_ov, cs=2):
    """Coarse downsampling can place the overlap a few rows off (a 1px error is
    enough to inflate the pixel MAD). Search the full-resolution rows around
    `ov0` for the exact overlap with the lowest pixel MAD; return (rows, mad).
    Columns are subsampled by `cs` for speed (does not affect the chosen row)."""
    hu, wu = up.shape
    best_ov, best_mad = ov0, np.inf
    for ov in range(max(min_ov, ov0 - s), min(max_ov, ov0 + s) + 1):
        bu = up[hu - ov:, side: wu - side: cs]
        bl = lo[:ov, side: wu - side: cs]
        n = min(bu.shape[0], bl.shape[0])
        if n < min_ov:
            continue
        m = float(np.mean(np.abs(bu[bu.shape[0] - n:] - bl[:n])))
        if m < best_mad:
            best_mad, best_ov = m, n
    return best_ov, best_mad


def detect_overlap(upper_gray, lower_gray, p):
    """How many rows at the TOP of `lower_gray` duplicate the BOTTOM of
    `upper_gray`. Returns the overlap in pixels, or 0 for "no confident overlap".

    A real scroll-overlap matches pixel-for-pixel (MAD ~ 0) at exactly one offset.
    The key is to pick the LARGEST overlap among the TIGHTEST matches -- not the
    largest match under a loose ceiling. A slightly larger, looser alignment
    (MAD a few) is a partial coincidence; trimming to it deletes real content and
    misaligns the seam, so it must lose to the exact (MAD ~ 0) overlap.

      1. Score every candidate overlap with cheap per-row signatures.
      2. Keep candidates whose signature is near the BEST (drops looser/larger
         partial matches before the costly pixel check).
      3. Measure each on real pixels (refined to exact rows).
      4. Return the LARGEST overlap whose pixel MAD is within `tight_margin` of
         the minimum -- the largest *exact* overlap.
    """
    hu, wu = upper_gray.shape
    side = min(p.ignore_side, (wu // 2) - 1) if wu > 2 else 0

    max_ov = int(min(hu, lower_gray.shape[0]) * p.max_overlap_frac)
    if max_ov < p.min_overlap:
        return 0

    # ---- coarse search on downsampled row signatures -------------------------
    s = max(1, p.coarse_scale)
    cu = _row_signature(upper_gray, side)[::s]
    cl = _row_signature(lower_gray, side)[::s]
    cmax = int(min(len(cu), len(cl), max_ov // s + 1))
    if cmax <= p.min_overlap // s:
        return 0

    scores = np.full(cmax, np.inf, dtype=np.float64)
    for k in range(max(1, p.min_overlap // s), cmax):
        scores[k] = np.mean(np.abs(cu[len(cu) - k:] - cl[:k]))

    cand = np.where(scores < p.coarse_accept)[0]
    if cand.size == 0:
        cand = np.argsort(scores)[:16]
    s_min = float(scores[cand].min())
    # Keep only candidates whose coarse signature is near the best; this drops
    # the looser, larger partial matches before the (costly) pixel check.
    pre = [int(k) for k in cand if scores[k] <= s_min + p.coarse_tight]
    if len(pre) > p.max_checks:        # uniform/white valley: keep best-scoring + a few largest
        pre = sorted(set(sorted(pre, key=lambda k: scores[k])[:p.max_checks - 6]
                         + sorted(pre)[-6:]))
    else:
        pre = sorted(set(pre))

    # ---- measure each kept candidate on real pixels (refined to exact rows) --
    results = []
    for k in pre:
        ov0 = min(k * s, max_ov)
        if ov0 < p.min_overlap:
            continue
        ov, mad = _refine(upper_gray, lower_gray, side, ov0, s, max_ov, p.min_overlap)
        if decide_overlap(ov, mad, p):
            results.append((ov, mad))
    if not results:
        return 0

    # ---- largest overlap among the tightest matches --------------------------
    m_min = min(mad for _, mad in results)
    return max(ov for ov, mad in results if mad <= m_min + p.tight_margin)


# --------------------------------------------------------------------------- #
# THE DECISION GATE  --  the heart of "smart"
# --------------------------------------------------------------------------- #
def decide_overlap(ov, pixel_mad, p):
    """Accept a candidate overlap only if its real pixels line up.

    `detect_overlap` already prefers the LARGEST candidate, so the only question
    left is: are these two bands actually the SAME pixels? A true scroll-overlap
    is near-identical (MAD ~0 for PNG, a few for re-compressed / resized JPEG); a
    coincidental alignment scores far higher (tens). We deliberately do NOT reject
    a band for being flat/white -- a speech bubble or blank gap shared by both
    screenshots is a real overlap and must be trimmed -- so the pixel MAD is the
    single gate. (An earlier version rejected low-variance bands, which wrongly
    butt-joined real overlaps that contained speech bubbles, duplicating them.)

    Tune `--mad-accept` to taste: lower = stricter (never trims by mistake, but
    may miss a heavily-recompressed overlap); higher = more tolerant.
    """
    return ov >= p.min_overlap and pixel_mad <= p.mad_accept


# --------------------------------------------------------------------------- #
# Slicing (SmartStitch-style: cut pages on blank rows)
# --------------------------------------------------------------------------- #
def safe_rows(strip_gray, sensitivity, ignore_side):
    """Boolean per-row mask: True where the row is a flat horizontal line and is
    therefore safe to cut through (no artwork / text / bubble edge crosses it).

    Mirrors SmartStitch: threshold = 255 * (1 - sensitivity/100); a row is safe
    if no adjacent horizontal pixel pair differs by more than the threshold.
    """
    threshold = int(255 * (1 - sensitivity / 100.0))
    w = strip_gray.shape[1]
    side = min(ignore_side, (w // 2) - 1) if w > 2 else 0
    interior = strip_gray[:, side: w - side]
    if interior.shape[1] < 2:
        # Too narrow to measure horizontal flatness; let the slicer use plain cuts.
        return np.zeros(strip_gray.shape[0], dtype=bool)
    horiz_diff = np.abs(np.diff(interior.astype(np.int16), axis=1)).max(axis=1)
    return horiz_diff <= threshold


def slice_points(strip_h, safe, split_height, min_page_frac=0.4):
    """Y-coordinates to cut at: aim for ~split_height, snap to the nearest safe
    row, but never make a page shorter than min_page_frac * split_height."""
    cuts = [0]
    y = 0
    min_page = max(1, int(split_height * min_page_frac))
    search = max(1, int(split_height * 0.6))   # how far to hunt for a blank row
    while strip_h - y > split_height:
        target = y + split_height
        lo = max(y + min_page, target - search)
        hi = min(strip_h - 1, target + search)
        window = np.where(safe[lo:hi + 1])[0]
        if len(window):
            cut = lo + int(window[np.argmin(np.abs((lo + window) - target))])
        else:
            cut = target                       # no blank row found -> forced cut
        cuts.append(cut)
        y = cut
    cuts.append(strip_h)
    # Merge a too-short trailing page into the previous one.
    if len(cuts) >= 3 and (cuts[-1] - cuts[-2]) < min_page:
        cuts.pop(-2)
    return cuts


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def load_rgb(path, target_width):
    img = Image.open(path).convert("RGB")
    if img.width != target_width:
        new_h = max(1, round(img.height * target_width / img.width))
        img = img.resize((target_width, new_h), RESAMPLE_LANCZOS)
    return np.asarray(img)                      # H x W x 3 uint8


def main():
    ap = argparse.ArgumentParser(description="Overlap-aware smart stitcher")
    ap.add_argument("-i", "--input", required=True, help="input folder")
    ap.add_argument("-o", "--output", required=True, help="output folder")
    ap.add_argument("-sh", "--split-height", type=int, required=True,
                    help="approx output page height (px)")
    ap.add_argument("-t", "--format", default="png",
                    help="output format, e.g. png/jpg/webp (dot optional)")
    ap.add_argument("-cw", "--width", type=int, default=None,
                    help="force a common width; default = min input width")
    # slicing knobs (mirror SmartStitch)
    ap.add_argument("-s", "--sensitivity", type=int, default=90)
    ap.add_argument("-ip", "--ignore-side", type=int, default=5)
    ap.add_argument("-lq", "--quality", type=int, default=100)
    # overlap knobs
    ap.add_argument("--mad-accept", type=float, default=10.0,
                    help="an overlap is invalid if its pixel MAD exceeds this")
    ap.add_argument("--tight-margin", type=float, default=1.0,
                    help="how far above the best overlap MAD still counts as a match")
    ap.add_argument("--coarse-accept", type=float, default=12.0,
                    help="row-signature score used to shortlist overlap candidates")
    ap.add_argument("--feather", type=int, default=40,
                    help="rows to cross-fade at each seam to hide tonal steps (0 = off)")
    ap.add_argument("--no-overlap", action="store_true",
                    help="disable overlap removal (plain concat = SmartStitch-like)")
    args = ap.parse_args()

    if args.width is not None and args.width < 1:
        print("ERROR: --width must be >= 1", file=sys.stderr)
        return 2

    ext = args.format.strip().lower().lstrip(".")
    FORMATS = {
        "png": ("PNG", "png"), "jpg": ("JPEG", "jpg"), "jpeg": ("JPEG", "jpg"),
        "webp": ("WEBP", "webp"), "bmp": ("BMP", "bmp"),
        "tiff": ("TIFF", "tiff"), "tga": ("TGA", "tga"),
    }
    if ext not in FORMATS:
        print(f"ERROR: unsupported format '{args.format}' "
              f"(choose from: {', '.join(sorted(FORMATS))})", file=sys.stderr)
        return 2
    pil_fmt, ext = FORMATS[ext]

    paths = collect_images(args.input)
    if not paths:
        print(f"ERROR: no images found under {args.input}", file=sys.stderr)
        return 2
    print(f"[smart_stitch] {len(paths)} images from {args.input}")

    # Common width: explicit, else the minimum width across the set.
    if args.width:
        target_width = args.width
    else:
        target_width = min(Image.open(p).width for p in paths)
    print(f"[smart_stitch] target width = {target_width}px")

    # Keep the side margin sane for narrow images.
    args.ignore_side = max(0, min(args.ignore_side, (target_width // 2) - 1))
    p = OverlapParams(args)

    # Build the deduplicated strip one image at a time. We hold the trimmed colour
    # parts plus the previous image's grayscale (for detecting the next overlap);
    # full-resolution colour images are freed as soon as they are appended.
    parts = []
    prev_gray = None
    total_trimmed = 0
    overlaps = []
    for idx, path in enumerate(paths):
        rgb = load_rgb(path, target_width)
        gray = rgb.mean(axis=2).astype(np.float32)

        ov = 0
        if prev_gray is not None and not args.no_overlap:
            ov = detect_overlap(prev_gray, gray, p)
        if ov:
            total_trimmed += ov
            overlaps.append((os.path.basename(path), ov))
            # Feather the seam: cross-fade the previous image's tail into this
            # image's matching overlap rows, so any residual tonal step (e.g.
            # animated sparkle/gradient regions that aren't pixel-identical
            # between screenshots) is spread over many rows instead of showing
            # as a hard horizontal line. For a perfect overlap this is a no-op.
            if args.feather and parts:
                f = min(args.feather, ov, parts[-1].shape[0])
                if f >= 4:
                    a = np.linspace(0.0, 1.0, f, dtype=np.float32).reshape(f, 1, 1)
                    tail = parts[-1][-f:].astype(np.float32)
                    band = rgb[ov - f:ov].astype(np.float32)
                    parts[-1][-f:] = ((1.0 - a) * tail + a * band).astype(np.uint8)

        parts.append(rgb[ov:].copy())
        prev_gray = gray          # full grayscale (one image's worth of memory)
        del rgb

    strip = np.concatenate(parts, axis=0)
    del parts
    strip_h = strip.shape[0]
    print(f"[smart_stitch] {len(overlaps)} overlaps removed, "
          f"{total_trimmed}px trimmed -> strip height {strip_h}px")
    for name, ov in overlaps:
        print(f"    overlap before {name}: {ov}px")

    # Slice the strip into pages on blank rows.
    strip_gray = strip.mean(axis=2).astype(np.float32)
    safe = safe_rows(strip_gray, args.sensitivity, args.ignore_side)
    del strip_gray
    cuts = slice_points(strip_h, safe, args.split_height)

    os.makedirs(args.output, exist_ok=True)
    pad = max(2, len(str(len(cuts) - 1)))
    save_kwargs = {}
    if pil_fmt in ("JPEG", "WEBP"):
        save_kwargs["quality"] = args.quality
    for i in range(len(cuts) - 1):
        page = strip[cuts[i]:cuts[i + 1]]
        out_name = f"{str(i + 1).zfill(pad)}.{ext}"
        Image.fromarray(page).save(os.path.join(args.output, out_name), pil_fmt,
                                   **save_kwargs)
    print(f"[smart_stitch] wrote {len(cuts) - 1} pages -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
