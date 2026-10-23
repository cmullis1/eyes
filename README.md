# Eyes

A command-line tool that lets Claude Code look at, and play, what it builds before it says it is
done. It opens a web page (or runs a Godot game scene) at real screen sizes, uses real mouse and
keyboard input, collects every console error and failed request, and hands back one short text report
plus one image Claude can read in a single step.

![A contact sheet Eyes made: the same page at two screen sizes, side by side](screenshots/contact-sheet.png)

## The problem

Claude Code is good at code and bad at knowing whether the result looks right. A project can show
hundreds of green tests while the page overflows the screen, a button hides under a banner, or the
game's combat does nothing the first time someone plays it. Without a way to look, the person ends up
being Claude's eyes, pasting screenshots into the chat. Eyes gives Claude the look first.

Here is its report on a deliberately flawed test page (`test/fixtures/overflow.html`), at a laptop
screen and a wide desktop screen:

```
FAIL overflow (laptop, desktop)
layout [laptop] hscroll #wide: page 2300px wide in a 1366px window
layout [laptop] offscreen #covered: covered at its centre by #banner
layout [laptop] textOverflow #label: content 1200px wide in a 683px box with overflow hidden
layout [desktop] offscreen #covered: covered at its centre by #banner
Read: .eyes/runs/20261023-082622-overflow/sheet.png
```

![The contact sheet for that report: a red banner covers the first button, a block is wider than the window, a label is cut off](screenshots/layout-problems.png)

## What it does

- **`eyes look <url or file>`** screenshots a page at each display profile and reports page errors,
  console errors, failed requests and layout problems (horizontal scroll, elements covered or cut off
  by the viewport, text overflowing its box).
- **`eyes run <scenario>`** runs a scripted scenario: real clicks, drags, key presses and typing,
  waits, named screenshots and checks on what a player would notice. Exit code 0 only if every check
  passed and nothing threw.
- **`eyes diff <scenario>`** compares named screenshots with approved baselines and writes a
  before, after and highlighted-difference image for each view that changed. A person approves new
  baselines with `eyes accept`, and `accept` refuses to run inside Claude Code.
- **`eyes film <url or scenario>`** records frames at a fixed rate under a controlled clock and makes a
  GIF, a contact sheet and a flicker score, to judge animation and shimmer.
- **`eyes serve "<command with {port}>"`** starts a dev server on a free port and waits until it
  answers (scenarios use this with `serve:`).
- **Godot scenes** run through Godot's movie writer with scripted input at a fixed frame rate, with
  checks evaluated against the live scene.
- **Touch views** emulate a phone or iPad, so the page sees `pointer: coarse` and `hover: none`.
- **Repeatable by design:** a fixed clock, frozen animations and seeded `Math.random` mean the same
  scenario gives the same pictures on unchanged code. No fixed sleeps; it waits for the page to be
  ready.

Exit codes: 0 passed, 1 a check, error, layout or diff failed, 2 bad usage, 3 the environment failed
(Chromium or the dev server died, not the page).

## Install

You need Node 22 or newer. From a clone of this repo:

```
node install.mjs
```

This installs Eyes into `~/.claude/tools/eyes` (outside `AppData`, so the Claude desktop app's
sandbox cannot hide it), runs `npm ci`, downloads Playwright's Chromium into that folder, writes
`eyes` (bash) and `eyes.cmd` (cmd, PowerShell) wrappers, and copies the skill in `skill/SKILL.md` to
`~/.claude/skills/eyes/` so Claude learns when and how to use the tool. Then:

```
~/.claude/tools/eyes/eyes look path/to/page.html
```

Options: `--target <dir>`, `--skills-dir <dir>`, `--skip-browsers`, `--uninstall`. Re-running is safe,
even while other Claude sessions are mid-run: the new copy is built in a staging folder and swapped in
only when it has fully worked, so a failed install leaves the old one working. It refuses to touch a
non-empty folder it did not create (it leaves a `.eyes-install.json` marker), or any folder inside or
holding this checkout.

## Screen sizes are examples

The built-in `desktop` (2560x1440 at 100%) and `4k` (2194x1234 CSS pixels at 175% scaling) profiles
are my two monitors, and they are the default views. They are only a starting point:

- `eyes calibrate` prints a link. Open it in a maximised Chrome at 100% zoom on each of your monitors
  and press the matching button; the exact window size and scale are stored in
  `~/.claude/tools/eyes/profiles.json` and replace the built-in numbers for that name. Set
  `EYES_CALIBRATION=<file>` to read and write a different file.
- You can add a profile of your own, such as a fixed 1920x1080 game canvas, by writing an entry
  with a new name (`width`, `height`, `deviceScaleFactor`) into that file.
- `laptop` (1366x768) is built in as a small-screen check.
- Touch profiles: `phone` 360x780 at 3x, `phone-l` 430x932 at 3x, `ipad-mini` and `ipad-13` in
  portrait and landscape (`-side`).

## Godot

A Godot scenario names the Godot console executable and the project. The path below is an example;
use wherever Godot lives on your machine, or set the `EYES_GODOT` environment variable instead.

```yaml
kind: godot
godot: { exe: C:/Godot/godot_console.exe, project: C:/path/to/game, scene: res://main.tscn, frames: 120, fps: 30, resolution: 1920x1080 }
steps:
  - { at: 10, press: ui_accept }
  - { at: 60, shot: mid-fight }
  - { at: 119, check: "$Player.position.x > 100" }
```

Each run gets its own empty user-data folder, so it never touches real save files. Inputs reach
physics one frame after the frame they are scheduled on. Gamepads, wall-clock ticks and `randomize()`
are not controlled. The full scenario formats, for web and Godot, are in `skill/SKILL.md`.

## Tests

```
npm ci
npm test
```

252 tests. The suite sets `EYES_CALIBRATION` to a path that does not exist, so it never reads or
writes your real calibration. The Godot tests need a Godot console exe (see above); the install tests
run `npm ci` into a temporary folder.

## How it was built

I got tired of being the first person to see Claude's visual bugs. An audit of about 200 of my Claude
Code sessions (4,478 subagent runs, April to October 2026) showed that the biggest cost was Claude
declaring work done without looking at it: green tests on a page that was broken on my screen, and
JavaScript measurements in a hidden browser pane standing in for a real look. I set the goals and the
limits: look at real screen sizes, use real input, never miss an error, run unattended, stay
repeatable, and never let Claude approve its own baselines. I also tested it on my own projects and
calibrated it on my two monitors.

Claude Code wrote nearly all of the code, with the test suite (252 tests) growing alongside it. It
is a command-line tool plus a skill rather than a server, so it works the same from the main session,
subagents and overnight runs, and images are plain files Claude opens with its Read tool.

## License

MIT, see [LICENSE](LICENSE).
