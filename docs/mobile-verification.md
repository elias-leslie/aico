# Mobile Verification

Repeatable Android verification for the web app lives in [`scripts/mobile-verification.sh`](../web/scripts/mobile-verification.sh).

The script now launches the emulator directly from the SDK, uses `sg kvm` automatically when the current shell has stale group membership, and defaults to headless mode for automation.

## Prerequisites

- Local frontend running at `http://localhost:3002`
- Android emulator launcher, created at `~/bin/start-aico-android-emulator` by `scripts/install-android-emulator.sh` (override with `ANDROID_EMULATOR_LAUNCHER`)
- `adb` installed
- `agent-browser` (a Chrome DevTools Protocol automation CLI) for scripted inspection; optional for `workflow`

Install the emulator stack with [`scripts/install-android-emulator.sh`](../web/scripts/install-android-emulator.sh) when needed.

## Fast Path

```bash
bash ./scripts/mobile-verification.sh workflow
bash ./scripts/mobile-verification.sh browser
```

That does four things:

1. Checks whether `adb`, `agent-browser`, `sg`, and the emulator binary exist.
2. Starts the emulator when needed and waits for `adb=device` plus `sys.boot_completed=1`.
3. Forwards Android Chrome DevTools to `localhost:9222`.
4. Runs `adb reverse tcp:3002 tcp:3002` and opens the web app in Android Chrome at `http://localhost:3002`.

The frontend answers only `localhost`, `127.0.0.1` and its public host (`frontend/proxy.ts`); any other Host gets a 403. The emulator's host alias `http://10.0.2.2:3002` is refused, so the script reverses the port and opens `localhost` instead.

## Common Commands

```bash
bash ./scripts/mobile-verification.sh doctor
bash ./scripts/mobile-verification.sh start-emulator
bash ./scripts/mobile-verification.sh wait-boot
bash ./scripts/mobile-verification.sh forward-cdp
bash ./scripts/mobile-verification.sh reverse-app
bash ./scripts/mobile-verification.sh open-app
bash ./scripts/mobile-verification.sh browser
```

Overrides:

```bash
MOBILE_EMULATOR_HEADLESS=0 bash ./scripts/mobile-verification.sh start-emulator
MOBILE_CDP_PORT=9333 bash ./scripts/mobile-verification.sh forward-cdp
AICO_MOBILE_PORT=3002 bash ./scripts/mobile-verification.sh open-app
```

## What To Verify

- The web app viewport scrolls vertically on touch without pull-to-refresh fighting it.
- Keyboard minimize/restore leaves the session live and readable.
- Typing goes straight into the session: letters and Backspace show in the agent's prompt at once, Enter runs it, a paste arrives as one block, Clear empties the prompt.
- The key row sits under the terminal; the terminal's last rows stay visible above it with the keyboard open.
- Connection state is obvious on mobile: a lost connection says so inside the terminal area with Reconnect, an ended session with New session.
- Scrolled up, the Latest pill (New output when something arrived) returns to the live bottom.
- Open search takes the whole header row; the current match is amber with readable text.
- The active pane remains usable after Android Chrome address-bar collapse/expand.

## Current Limitation

CDP attachment to Android Chrome is stable, but fully scripted xterm touch input inside Android Chrome is still not a clean end-to-end automation path. Use `agent-browser` for inspection and targeted interactions, then finish with manual touch validation when xterm input automation gets flaky.
