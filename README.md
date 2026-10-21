# MRI Viewer

A local DICOM viewer with browser-based windowing, zoom, pan, measurements,
and optional report-linked annotations.
It runs entirely on this machine — the server binds to `127.0.0.1` and nothing
is uploaded anywhere.

## Setup

The repository contains the viewer source and a report-grounding prompt template.
Scan files, medical reports, study-specific annotations, local backups, and the
Python environment are excluded from Git.

From the cloned repository, create an environment and install the dependencies:

```sh
python3 -m venv venv
./venv/bin/python -m pip install -r requirements.txt
```

The pinned dependencies match the existing installation, tested on Python 3.9.
Keep your DICOM study in a separate local folder. By default, the viewer looks
for an `MRI` folder next to the repository; you can also pass a path explicitly
or set the `MRI_ROOT` environment variable.

## Run it

Double-click **`Open MRI Viewer.command`** in Finder, or from a terminal:

```sh
cd /path/to/mri-viewer
./venv/bin/python server.py                 # defaults to ../MRI
./venv/bin/python server.py /path/to/study  # any folder with an IMAGES/ dir
./venv/bin/python server.py --port 9000 --no-browser
```

Your browser opens at `http://127.0.0.1:8787/`. Press `Ctrl+C` in the terminal
to stop.

## Controls

| | |
|---|---|
| Scroll wheel | next / previous slice |
| Left-drag | window level & width (brightness / contrast) |
| Right-drag, middle-drag, shift-drag | pan |
| ⌘-drag, ⌥-scroll | zoom |
| Double-click | fit to window |
| ↑ ↓ ← → | one slice · Page up/down ten · Home/End ends |
| 1 … 9 | jump to series |
| Space | cine loop |
| m / c | measure distance in mm / clear |
| i / s | invert / smoothing |
| f / r | fit / reset |
| a | auto-window the current slice |
| l / g | toggle grounded labels / grounded-report panel |

## Grounded report labels

This optional feature loads local files from `grounding/`: `grounded_report.json`,
`annotations.json`, and `report.png`. These contain study-specific information
and are not included in the repository. Without them, the viewer still displays
scans and hides the findings panel. The prompt template in
`agent/report_grounding_prompt.md` documents the report-grounding workflow and
JSON structure; the viewer itself does not run an AI model.

The right-hand **Grounded findings** panel contains the radiologist's report
split into atomic statements. Selecting a statement jumps to its cited series
and best slice. Selecting another cited image range in the detail pane changes
to that supporting plane.

The rectangle is intentionally a broad anatomical-region locator, not a lesion
segmentation:

- solid green: the pixels independently support the report statement;
- dashed amber: the correct reported structure and location were found, but the
  abnormality was not independently discernible in this rendering;
- red: the reported structure/finding could not be located.

The report's own certainty remains separate. In particular, a statement marked
"suspected / probably" stays hedged in both the panel and image label. Press
**Labels** or `l` to hide the canvas annotations without closing the report.

**Open original findings report** shows the supplied report-page image. The
embedded PDF button is labelled **Referral / request PDF** because that DICOM
document is the request form rather than the findings report.

## How it works

`server.py` indexes the study once at startup (reading headers only), then
serves each slice's **raw stored 16-bit pixels** over HTTP. The browser applies
the modality rescale (`RescaleSlope`/`Intercept` — Philips varies these per
slice, which is easy to get wrong) and the VOI window itself, so the full 12
bits of the acquisition stay live while you drag the window around. Nothing is
converted to 8-bit on disk and no derived copy of the study is written.

Decoded slices are cached in RAM on both sides (140 slices server-side, 90 in
the browser) and neighbouring slices are prefetched, so scrolling stays smooth
after the first pass through a series.

The encapsulated referral / request PDF in series 1000 is served at
`/report.pdf`. Grounded report data and broad localizer boxes are loaded from
`grounding/`; the supplied findings-report image is served locally from the same
folder.

## Requirements

Dependencies are listed in `requirements.txt`: pydicom, numpy, pylibjpeg, and
pylibjpeg-libjpeg. The last package decodes JPEG-Lossless Process 14 pixel data.
Install them in the local `venv/` as described above; no Python environment is
bundled with the repository.
