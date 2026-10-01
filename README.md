# CamBoi

Step away, stay on camera.

CamBoi records a few seconds of you and loops it into your video calls, so you can
leave your desk while you still look present. Your audio is never touched, never
recorded and never routed. Nothing is uploaded — clips live in your browser profile.

It is a Chrome extension, not a system virtual camera: it works in **any call that
runs in a Chrome tab** (Google Meet, Microsoft Teams web, the Zoom web client,
Discord, Whereby, Jitsi…), and it cannot reach native desktop apps.

## Install

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load unpacked**
→ select the `dist/` folder.

The Studio tab opens on first install. Grant it camera permission, line yourself up,
and record your first clip.

## Using it

- **Studio** — record, trim, rename, pin, import and export clips. Recordings have no
  length limit; set an auto-stop if you want one. The ghost overlay
  shows the first frame of your selected clip at adjustable opacity, so you can match
  your pose before recording. That alignment is what makes the switch invisible.
- **In-page controls** — a draggable panel on call pages: step away, go live, panic
  freeze, record, pick a clip, pick an effect. Record is a toggle — it runs until you
  press Stop, showing elapsed time and size as it goes.
- **Toolbar popup** — the same controls, plus a per-site on/off switch.
- **Keyboard shortcuts** — editable at `chrome://extensions/shortcuts`:

  | Action | Default |
  | --- | --- |
  | Step away / go live | `Alt+Shift+L` |
  | Go live now | `Alt+Shift+K` |
  | Panic: freeze the picture | `Alt+Shift+P` |
  | Next clip | `Alt+Shift+N` |

## Features

**Loop styles** — *Ping-pong* walks the clip forward then backward, so there is no
seam at all. *Crossfade* plays forward and dissolves the tail into the head at the
wrap. *Simulated lag* adds irregular holds, so the loop reads as a struggling uplink.

**Live effects** — *stutter*, *catch-up lag* and *low bitrate*, applied to whatever is
on screen. Their real job is to mask the moment you switch, by making it look like an
ordinary network hiccup rather than a cut.

**Panic freeze** — holds the current picture instantly, live or looped.

**Start calls on the loop** — optional. With it on, the moment a site opens your camera
you are already on the loop, cutting straight in with no crossfade. You press Go live
when you actually want to be seen, rather than the other way round.

If the clip is still loading when the camera opens, CamBoi sends **no frames at all**
rather than falling back to the live camera — the page waits instead, for up to five
seconds, after which it goes live rather than leave a real call dark forever.

**Start at a random point** — optional, and designed for pages that open the camera for
a moment, grab a still and close it again. Each takeover begins somewhere different in
the clip, never twice in the same place, so repeated snapshots are not identical. A
pre-decoded set of frames spread across the clip is kept in reserve while this is on,
so a camera that is only open for a few hundred milliseconds is still covered.

**No length limit** — record for as long as you like. Clip frames are held in memory
until you press Stop, so the Studio shows the running size and says something once a
recording passes 750 MB. A minute of 720p is roughly 100 MB.

**Clean-frame guard** — CamBoi refuses to go live, or to start recording, while the
camera is dark or still adjusting its exposure. No more cutting back to a black frame.
It gives up and goes live anyway after four seconds.

**Custom camera name** — what sites call your camera in their device pickers.

## How it works

A content script running in the page's own JavaScript context replaces
`navigator.mediaDevices.getUserMedia` before the call app loads. When the site asks for
your camera, CamBoi opens the real one, draws it to a canvas, and hands the site that
canvas's video track — with the real audio track passed through untouched. Normally the
canvas just mirrors the live camera, invisibly. When you step away, it plays your clip
instead.

Two decisions are worth knowing about:

**The real camera keeps running the whole time**, even while looping. It is the frame
clock, it powers clean-frame detection, and it means going live is instantaneous. The
cost is that your camera indicator light stays on.

**Clips are stored as one WebP still per frame**, not as a video file. That costs a
little disk, but it buys exact random access — so ping-pong is just walking the index
backwards, with no reverse re-encode — and it avoids `blob:` URLs entirely, so a
site's Content-Security-Policy can never block playback.

**Frames are read straight off the camera track** with `MediaStreamTrackProcessor`,
not drawn from a hidden `<video>`. Chrome only presents frames for a video element it
considers visible, so an off-screen one silently stops delivering; the track reader has
no such heuristic and keeps running in a backgrounded tab — which is exactly where you
are when you have stepped away. Camera frame delivery is also the output clock, so no
timer or animation frame is involved.

The output canvas is deliberately kept out of the document, where no page script or
stylesheet can reach it. That means `captureStream(0)` plus an explicit `requestFrame()`
per rendered frame: Chrome's automatic capture mode produces nothing for a detached
canvas, since there is no compositor pass to drive it.

## Limitations

- Chrome tabs only. Native Zoom, Teams, FaceTime and OBS cannot see CamBoi.
- Your camera light stays on while looping, by design.
- Keyboard shortcuts only fire while Chrome has focus.
- Turning CamBoi on or off for a site takes effect the next time that page asks for
  the camera — reload or rejoin.
- A site determined to detect a replaced `getUserMedia` could; CamBoi masks the obvious
  `toString()` check and does not try harder than that.
- Screen sharing (`getDisplayMedia`) is untouched.

## Development

```bash
npm run dev        # rebuild on change
npm run typecheck
./test/run.sh      # end-to-end tests
```

`test/run.sh` builds, launches a throwaway Chrome with a synthetic camera, loads the
extension over the DevTools protocol, and asserts the real behaviour end to end —
interception and passthrough; recording a clip, looping it, panic-freezing and going
live again; that an uncapped recording is never truncated; that auto step-away puts a
fresh call on the loop without ever showing the live camera; and that repeated
short-lived camera sessions each start at a different point and never leak a live
frame. It never touches your real Chrome profile. (Chrome removed
`--load-extension` in M136, so it loads via `Extensions.loadUnpacked`, which needs
`--enable-unsafe-extension-debugging`.)

After a rebuild, hit reload on the extension card in `chrome://extensions`, then reload
any open call tab — content scripts are injected at document start.

```
src/
  inject/      MAIN world: the getUserMedia patch, pipeline, loop player, effects
  content/     ISOLATED world: the relay between page and worker, plus the overlay
  background/  service worker: hotkeys, clip storage, byte streaming
  studio/      the recording and clip-management page
  popup/  options/  shared/
test/          end-to-end tests driven over the DevTools protocol
```
