# Test pages for the GeckoView browser prototype

Self-contained pages for the 8 content types the visual filter must handle.
All media is real (copies of the scanner's labeled test set + the Obama
video), so the expected verdicts are known in advance.

## How to run them on a real device

```bash
# On a computer on the same Wi-Fi as the phone (or on the phone itself):
cd android/test-pages
python3 -m http.server 8130 --bind 0.0.0.0
# In the Filter Browser (MainActivity -> "Open filter browser"), open:
#   http://<computer-ip>:8130/index.html
```

`file://` loading also works (the extension matches `file:///*`), but
serving over HTTP is the realistic path and avoids `file://` quirks with
video/WebGL textures.

## What to check on each page

In THIS prototype there is no on-device person detector yet, so the only
correct outcome on every page is: **everything visual is covered** (dark
overlay reading "Filtered — image covered") and the browser status line
shows `covered: N, allowed: 0, blocked: 0`. A page where anything visual
is visible uncovered is a filter failure — record which element and how
it got through. (When a real detector lands, the landscape controls
— `l1-glacier-lake.jpg` — are the elements that should become ALLOW.)

| Page | What it exercises | Watch for |
|---|---|---|
| 01-html-images | `<img>`, `<picture>`/srcset, `loading=lazy`, `data-src` set by JS at 1 s, `<input type=image>` | The data-src image must be covered after it appears at 1 s; lazy image when scrolled into view |
| 02-css-backgrounds | `background-image` (person, crowd, landscape), sprite via `background-position`, `data:` URI background, background set by JS, text over a background | The card's text must stay readable while its background is stripped; every box covered |
| 03-canvas | Canvas 2D `drawImage` (person + landscape), animated canvas fed by video frames, `<img>`/`<video>` controls | Animated canvas must stay covered as frames change |
| 04-svg | Inline `<svg>` with embedded raster photo, shapes-only SVG, `<img src="*.svg">`, SVG as CSS background | The photo inside the inline SVG must not show through |
| 05-webgl | WebGL canvas with a person photo as texture; WebGL canvas with a procedural shader | Both must be covered. `toDataURL` on a WebGL canvas without `preserveDrawingBuffer` returns blank — the filter must treat blank as "cannot check", never as clean |
| 06-video-frames | Video paused at 5 s, autoplaying muted loop, video with a person-photo poster | Covered videos are paused by the filter (no audio from a hidden video). The poster must be covered too |
| 07-live-streams | `canvas.captureStream()` feeding a `<video>` (no permission needed); optional camera via `getUserMedia` | The stream must be covered and re-sampled while playing. Camera will probably be denied — the prototype has no PermissionDelegate yet; record the denial as a finding, not a pass |
| 08-dynamic-content | Image added at 2 s, images/divs/canvas added by buttons, carousel swapping `src` every 3 s, infinite scroll appending images | Nothing may flash uncovered when it appears; the carousel's new image must be covered on every swap |

## Assets

| File | What it is |
|---|---|
| `assets/p1-huang-portrait.jpg` | Person (Jensen Huang portrait, 960×1279) — expect COVER |
| `assets/d1-crowd-funeral.jpg` | Crowd (person) — expect COVER |
| `assets/l1-glacier-lake.jpg` | Landscape, no person — control; covered in this prototype, ALLOW once a detector exists |
| `assets/obama-chile-480p.webm` | Obama speaking, person in frame throughout — expect COVER |
| `assets/person.svg` / `assets/shapes.svg` | SVG with embedded photo / shapes-only |

Sources: `../../scanner/testset/` and `../../scanner/test-video-canvas/assets/`
(copied 2026-11-18; the originals stay where they are).
