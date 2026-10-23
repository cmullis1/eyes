---
name: eyes
description: Look at and play what you build before saying it is done. Use for any web page, UI, Godot game visual or playability change - before "done" or "take a look", at the end of every build task in subagent or overnight work, and when the user says something looks wrong. Screenshots at the user's real monitor sizes, real input, console errors, contact sheet.
---

# Eyes

Run it from Bash: `{{EYES_DIR}}/eyes <command>` (PowerShell: `eyes.cmd`). Installed at `{{EYES_DIR}}`.

## When to use it
- Before saying any UI, page, game-visual or playability change is done, and before "take a look".
- As the last step of each build task in subagent or overnight work; put the report in your result.
- When the user reports something looks wrong: reproduce it with Eyes first.
- Open the contact sheet (the `Read:` path) with the Read tool every time. Never report a visual fix from DOM measurements alone.

## Commands
| Command | Use |
|---|---|
| `eyes look <url\|file> [--views desktop,4k] [--wait sel] [--full]` | Screenshot at each display profile; console errors, failed requests, layout problems |
| `eyes run <scenario.yaml\|.mjs>` | Real input, waits, checks, named shots; exit 0 only if all checks pass |
| `eyes diff <scenario\|url> [--update]` | Compare shots with baselines; `--update` proposes pending ones (never from a failing run) |
| `eyes film <url\|scenario> --seconds 3 --fps 20` | Frames, GIF, contact sheet, flicker score. Desktop view unless `--views`; always `clock: fixed` |
| `eyes serve "<cmd with {port}>"` | Start a dev server on a free port (scenarios use `serve:`) |
| `eyes calibrate` | The user runs this once (see Profiles) |

Runs land in the nearest `.eyes/runs/`. Every step, script, shot and layout scan has `--step-timeout` ms (default 30000).
Exit codes: 0 passed, 1 check/error/layout/diff failed, 2 bad usage, 3 environment failure (Chromium or the dev server died, not the page: run it again; Chromium's log is `browser.log` in the run folder).

## Reading a report
1. Errors first: page errors, console errors, failed requests, failed checks, layout lines (scroll, cut off, overflow). Fix these, re-run.
2. Then Read the contact sheet and look. Say what you saw at both profiles.
3. `GPU:` line says software rendering: tell the user screenshots may differ from their GPU.
4. `flicker` above 0.020 (worst 64 px tile) means visible strobing or shimmer there.

## Web scenario (`.eyes/scenarios/buy.yaml`)
```yaml
name: buy-and-attack
before: npm run build                     # optional, once, in the project root
serve: npm run dev -- --host 127.0.0.1 --port {port}   # optional; url is then a path
url: /
views: [desktop, 4k]
clock: fixed              # paused time, frozen animations, seeded Math.random
seed: 7                   # optional; else the page's window.__eyes.seed, else a default
stepTimeout: 30s          # optional deadline per step
mask: ["#clock"]          # regions diff ignores
steps:
  - click: "text=New campaign"   # or tap: <selector>, a finger; touch views only (see Profiles)
  - advance: 1s           # let timers build the content
  - wait: "#map canvas"
  - drag: { from: "#unit", to: { canvas: "#map canvas", x: 0.4, y: 0.6 } }
  - key: Space
  - type: { into: "#name", text: Bob }
  - shot: after-attack
  - shot: { name: whole-page, full: true }
  - check: "window.game.units.some(u => u.engaged)"
  - check: { visible: "#deploy-button" }   # also hidden: / text: + contains:
```
`clock: fixed`: timers, requestAnimationFrame and animations only move on `advance` steps (and film frames); put an `advance` before waiting for content a timer builds. A page may set `window.__eyes = {ready: false}` and later `ready = true`: Eyes waits for it. `.mjs` scenarios: `export const config` (same keys) and `export default async (page, eyes)`; `page.clock.runFor` there does not advance CSS animations.
`serve` and `before` run through cmd.exe on Windows: write relative executable paths with backslashes (`.\tools\build.cmd`).

## Godot scenario
```yaml
kind: godot
godot: { exe: C:/Godot/godot_console.exe, project: C:/path/to/game, scene: res://main.tscn, frames: 120, fps: 30, resolution: 1920x1080 }
steps:
  - { at: 10, press: ui_accept }     # also release:, mouse: {x, y, button}
  - { at: 60, shot: mid-fight }
  - { at: 119, check: "$Player.position.x > 100" }
```
- Needs the Godot console exe: `godot: {exe: ...}` or the EYES_GODOT environment variable.
- Each run gets its own user data folder, never the user's saves. At most 9,000 frames; only shot or sampled frames are kept.
- Inputs reach physics one frame after the frame they are scheduled on. Gamepads, wall-clock ticks and `randomize()` are not controlled.

## Baselines
- Never run `eyes accept` (it refuses inside Claude Code). Propose with `eyes diff <scenario> --update`, then tell the user to look at the pending images and run `eyes accept <scenario>` in their own terminal.
- Projects adopting Eyes git-ignore `.eyes/runs/` and `.eyes/baselines/.pending/`; commit `.eyes/baselines/` (accepted) and `.eyes/scenarios/`.

## Profiles
`desktop` is 2560x1440 @1; `4k` is 2194x1234 CSS px @1.75: the built-in default views, which are the author's two monitors (examples, not assumptions). `eyes calibrate` records the user's own exact window sizes: the user runs it once and opens the printed link in Chrome on each monitor. `laptop` (1366x768) is a small-screen check.
Touch views emulate a real phone or iPad (touch and mobile on): the page sees `pointer: coarse` and `hover: none`, and honours its viewport meta tag. Sizes are the viewport in CSS px: `phone` 360x780 @3, `phone-l` 430x932 @3, `ipad-mini` 744x1133 @2, `ipad-mini-side` 1133x744 @2, `ipad-13` 1024x1366 @2, `ipad-13-side` 1366x1024 @2 (`-side` is landscape). Use them for any touch or small-screen layout: a small desktop window is not a touch device. `tap:` steps need every view in the run to be a touch view; `click:` works everywhere.
