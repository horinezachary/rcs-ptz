# PTZ Camera Control module

A Rack Control Surface module; see README.md. Built like the other module repos (rcs-PixelHue, rcs-Pixera): SDK
linked from a rack-control-surface checkout, signed releases on every merge to master (the default branch).

## Working agreement

Features go on a branch and a pull request. Zac reviews, then merges. Title PRs `feat: ...` for features and
`fix: ...` for fixes; the title decides the version bump.

## Real cameras

PTZ cameras on a show are live equipment. Reading from them is fine. **Ask Zac before sending any control command
to a real camera** (any move, zoom, focus, preset recall or store, home, or picture change: VISCA commands, Panasonic
`aw_ptz`/`aw_cam` commands, ONVIF PTZ or SetImagingSettings). Develop against the simulator (`src/sim`,
`npm run sim`).

The camera is the source of truth: config and state hold only the module's own settings; start, restore and
reconnect only read; commands go out only on an operator action with Allow controls on. Logins go in secrets.

`ui/video.js` and `web/video.js` are the same file (a test checks it).
