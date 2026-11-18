# PTZ Camera Control

A [Rack Control Surface](https://github.horinetech.com/rcs-releases/) module for PTZ cameras: see every camera's
live picture on the panel, tap one to select it, and pan, tilt, zoom and focus it from the Stream Deck. It also sets
the camera's picture (exposure, iris, gain, shutter, white balance, R/B gain) and can bridge each camera to ONVIF so
other software sees it as an ONVIF camera with RTSP video and PTZ.

Everything has been built and tested against the simulated cameras in `src/sim`; **no real camera has been tested
yet.**

- **Cameras**: a tile per camera with its live picture (RTMP pushed by the camera, or pulled from an address), and a
  card for the selected camera with its make, control protocol, position, video format, HOME and AF.
- **Picture**: the selected camera's picture settings, as the camera reports them. Settings that need another mode
  first (iris in Full auto, R gain in Auto white balance) are greyed out and say what to change.
- **Presets**: 16 presets per camera, HOME and STORE (STORE arms; the next preset tap stores).
- **Setup**: add a camera by make and address, or scan the network; Allow controls; live video on the unit's own
  screen (every camera, the selected one, or none); the ONVIF bridge switch.

The web view has the same pages, plus everything the panel leaves out: ports, stream URLs and keys, camera logins,
preset names, pan/tilt inversion, reordering, and the bridge's ports and login. Its Cameras page has its own
selected camera and a D-pad you hold to move (it stops when you let go), so a second operator can drive a different
camera from a browser than the one on the unit's keys.

## Supported cameras

| Make | PTZ control | Picture settings | Identity / discovery |
| --- | --- | --- | --- |
| Sony (SRG, BRC, FR7…) | VISCA over IP (UDP 52381) | VISCA: AE mode, iris, gain, shutter, bright level, white balance + one push, R/B gain, saturation, detail, focus mode, one-push AF | VISCA version inquiry; Sony `ENQ:network` broadcast (UDP 52380) |
| BirdDog (P100, P200, P400, P4K, X1…) | VISCA over IP (UDP 52381) | VISCA, as Sony | `GET :8080/about`; mDNS `_ndi._tcp` |
| PTZOptics | VISCA over TCP (5678) or UDP (1259 on older models, set the port) | VISCA, as Sony | VISCA version inquiry; TCP 5678 probe |
| Generic VISCA | VISCA over UDP or TCP, any port | VISCA, whichever inquiries the camera answers | VISCA version inquiry |
| Panasonic AW-UE / AW-HE | AW HTTP CGI (`/cgi-bin/aw_ptz`, port 80) | `/cgi-bin/aw_cam`: iris + auto iris, gain (incl. AGC), shutter, white balance mode + AWB, R/B gain, detail, focus mode, one-push AF | `#O` power query |
| ONVIF (Profile S, any make) | ONVIF PTZ: ContinuousMove/Stop, presets, home | ONVIF Imaging: exposure mode, iris, gain, exposure time, brightness, WB mode, Cr/Cb gain, saturation, contrast, sharpness, focus | WS-Discovery probe |

Notes:

- **There is no G gain.** None of VISCA, the Panasonic CGI or ONVIF Imaging offers a green gain; white balance is
  set with R and B gain (Cr/Cb on ONVIF) against a fixed green. The module shows R gain and B gain only.
- BirdDog cameras take picture settings over VISCA, not BirdDog's REST API, so they need no login.
- The panel only offers settings the camera answers an inquiry for, with the camera's own value.
- ONVIF and Panasonic cameras can have a login; it is kept with the module's secrets, never in a save.
- Panasonic cameras want at least 130 ms between requests. The module queues them, sends moves before reads and
  merges repeated moves into the latest one.

## Stream Deck

KEY MODE (key 15) switches between three layouts. SPEED (key 14) cycles slow, medium and fast. Keys show
VIEW ONLY until Allow controls is on.

**PTZ** (the default)

| | | | | |
| --- | --- | --- | --- | --- |
| ↖ | ▲ | ↗ | ZOOM + | FOCUS NEAR |
| ◀ | CAM (next camera) | ▶ | ZOOM − | FOCUS FAR |
| ↙ | ▼ | ↘ | SPEED | MODE |

A move lasts while the key is held. FOCUS NEAR/FAR switch an autofocus camera to manual first.

**Presets**: keys 1–12 recall presets 1–12, 13 is HOME, 14 is STORE (then a preset key stores into it).

**Picture**: the top row raises iris, gain, shutter, R gain and B gain, the middle row lowers them; the bottom row
cycles AE mode and white balance, runs one-push white balance and toggles autofocus.

On a larger deck (an XL, 8×4, or a Stream Deck + XL, 9×4) these 15 keys stay in the top left. The bottom row picks
a camera directly, one key per camera, under the 15 keys. The columns to their right recall presets: 4 rows of 3 on an
XL (4 of 4 on a + XL), presets 1 onwards in PTZ and Picture modes and 13–16 in Presets mode, where STORE then one of
those keys stores into it. With more than 5 cameras the camera row runs the whole width and the presets keep the 3
rows above it. This needs controller 0.21.0 or later; older controllers show the 15-key layout.

Moves stop when the keys go to another module, when the deck changes size, when the selected camera changes and
when the module stops.

## The camera is the source of truth

Pan/tilt/zoom, picture settings and presets are read from the camera (every 2 seconds) and kept only in memory.
State holds the selected camera, key mode and speed; config holds the camera list, preset names, Allow controls (off
by default), the live video choice, the RTMP port and the bridge settings. Logins are secrets. Starting, restoring a
save, resuming after a power cut and reconnecting only read. A command goes out only on an operator's action with
Allow controls on, and after a picture change the module reads the setting back so the page shows what the camera
took.

## Live video

Each camera's picture comes in as H.264 over RTMP, either:

- **pushed by the camera** to the unit, `rtmp://<unit ip>:1935/live/<stream key>` (each camera's key is on its
  Setup card in the web view; an unknown key is refused), or
- **pulled** from an `rtmp://` or HTTP-FLV address (another server, an encoder, a camera that serves RTMP),
  only while someone is watching that camera.

The module never decodes or re-encodes video. It repackages the H.264 as fragmented MP4 for the browser (Media
Source Extensions), and as RTP for the bridge, so one camera costs the unit a few percent of a Pi core. What costs
real CPU is the *panel's browser decoding* the pictures: the Pi 5 has no H.264 hardware decoder, so four 1080p
streams will load it heavily. Set the cameras' secondary (low-resolution) stream to push to the unit, or set Live
video to "selected camera only" or "none". The web view always shows video (the browser's own machine decodes it).
H.265 over Enhanced RTMP is detected and shown as unsupported.

### Pointing a camera at the unit

For cameras whose web API can set their RTMP push, a camera's Setup card in the web view has **Point camera at
this unit**. It sets the camera's RTMP destination to `rtmp://<the unit's address on the camera's network>:1935/live/<stream key>`
and turns its RTMP stream on. It is a command to the camera, so it asks first, needs Allow controls on, and uses the
camera's saved login (an admin user). **Read from camera** shows the camera's current setting without changing it.

| Make | How | Documented for | Read back |
| --- | --- | --- | --- |
| Panasonic | `/cgi-bin/rtmp_ctrl?cmd=stop`, `set_rtmp_param?type=1&url=&key=`, `rtmp_ctrl?cmd=start` (Basic login) | AW-UE4, AW-UE20, AW-HE20 | `get_rtmp_param`, `get_rtmp_status` |
| Sony | `/command/rtmp.cgi?RTMPURL=<url with key>&RTMPEnable=on` (Digest login, web port 80) | SRG-XP1, SRG-XB25 | `inquiry.cgi?inqjs=rtmp` |
| PTZOptics | `POST /cgi-bin/param.cgi?post_network_other_conf&rtmp1_mrl=` / `rtmp1_key=` / `rtmp1_en=1` (Digest, port 80) | Move 4K, Link 4K, Move SE, Studio Pro | not documented |
| BirdDog, ONVIF, generic VISCA | Not possible: BirdDog's API has no RTMP settings, and ONVIF and VISCA have no command for a push address. Set it in the camera's web page. | | |

Other models of these makes may answer the same commands (the BRC-X400 and AW-UE150 list RTMP commands too,
but their exact names weren't checkable), and none has been tried on a real camera yet. The Sony and PTZOptics web
port is set on the card (empty: 80).

## RTMP to ONVIF bridge

Off by default. When on, every camera appears on the network as its own ONVIF Profile S camera:

- **Device, Media and PTZ services** on its own HTTP port (8000 for the first camera, 8001 for the next…), with
  WS-Discovery answers on 239.255.255.250:3702 so VMS and NDI/ONVIF tools find it.
- **Video** as RTSP at `rtsp://<unit ip>:8554/<camera id>`: the camera's own H.264, packetised as RTP (TCP
  interleaved or UDP), never transcoded. A camera with no video has a PTZ-only profile.
- **PTZ**: ContinuousMove, Stop, GotoPreset, SetPreset and GotoHomePosition translated into the
  camera's own protocol (VISCA, Panasonic CGI or ONVIF). Moves obey Allow controls like the keys do, and a
  ContinuousMove without a timeout stops after 15 seconds.
- An optional login (WS-Security digest, and Digest auth on RTSP) set in the web view; without one anyone on the
  network can watch and, with Allow controls on, move the cameras.

On a Pi this is practical because of the no-transcode design: each bridged stream is a copy, not a re-encode. It
has been checked with ffprobe/ffmpeg (RTSP over TCP and UDP) and the module's own ONVIF client; not yet with a VMS.

## Discovery

Scan in Setup (panel or web) finds cameras on the unit's own /24 networks, or a network you type (`10.0.0.0/24`).
It only asks: an ONVIF WS-Discovery probe, Sony's VISCA network inquiry, mDNS for NDI names (BirdDog), and on each
address a VISCA version inquiry (UDP 52381), the VISCA TCP port 5678, Panasonic's `#O` and BirdDog's `/about`.
Found cameras are listed with make and model; Add puts them in the camera list.

## Development

```sh
npm install                      # links the SDK from ../rack-control-surface (or: npm run link-sdk -- <path>)
npm test
npm run sim                      # 2 simulated cameras (RCS_PTZ_SIM_COUNT=1-4)
npm run dev                      # the panel simulator with this module
```

Each simulated camera answers VISCA UDP (52381+n), VISCA TCP (5678+n), Panasonic HTTP (20001+10n), ONVIF
(20002+10n) and BirdDog `/about` (20003+10n), answers Sony discovery, and pushes a test picture
(`sim/cam.flv`, made by `scripts/make-sim-video.mjs`) to `rtmp://127.0.0.1:1935/live/simcam<n>`. Set
`RCS_PTZ_SIM_KEYS=key1,key2` to push to the stream keys the module shows, then add the cameras in Setup as
127.0.0.1 with the sim's port.

Releases are signed and published by `.github/workflows/release.yml` on every merge to master; the PR title
(`feat:` / `fix:`) decides the version bump.
