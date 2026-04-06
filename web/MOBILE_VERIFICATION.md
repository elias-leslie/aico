# Mobile Verification

Repeatable Android verification for A-Term lives in [`scripts/mobile-verification.sh`](scripts/mobile-verification.sh).

The script now launches the emulator directly from the SDK, uses `sg kvm` automatically when the current shell has stale group membership, and defaults to headless mode for automation.

## Prerequisites

- Local frontend running at `http://localhost:3002`
- Android emulator launcher at `~/bin/start-a-term-android-emulator`
- `adb` installed
- `agent-browser` installed for CDP-driven inspection

Install the emulator stack with [`scripts/install-android-emulator.sh`](scripts/install-android-emulator.sh) when needed.

## Fast Path

```bash
bash ./scripts/mobile-verification.sh workflow
bash ./scripts/mobile-verification.sh browser
```

That does four things:

1. Checks whether `adb`, `agent-browser`, `sg`, and the emulator binary exist.
2. Starts the emulator when needed and waits for `adb=device` plus `sys.boot_completed=1`.
3. Forwards Android Chrome DevTools to `localhost:9222`.
4. Opens A-Term in Android Chrome at `http://10.0.2.2:3002`.

## Common Commands

```bash
bash ./scripts/mobile-verification.sh doctor
bash ./scripts/mobile-verification.sh start-emulator
bash ./scripts/mobile-verification.sh wait-boot
bash ./scripts/mobile-verification.sh forward-cdp
bash ./scripts/mobile-verification.sh open-app
bash ./scripts/mobile-verification.sh browser
```

Overrides:

```bash
MOBILE_EMULATOR_HEADLESS=0 bash ./scripts/mobile-verification.sh start-emulator
MOBILE_CDP_PORT=9333 bash ./scripts/mobile-verification.sh forward-cdp
A_TERM_MOBILE_URL=http://10.0.2.2:3002 bash ./scripts/mobile-verification.sh open-app
```

## What To Verify

- A-Term viewport scrolls vertically on touch without pull-to-refresh fighting it.
- Keyboard minimize/restore leaves the a-term session live and readable.
- Voice/keyboard transitions keep the operator oriented.
- Connection state is obvious on mobile, including reconnect affordance for transient failures.
- The active pane remains usable after Android Chrome address-bar collapse/expand.

## Current Limitation

CDP attachment to Android Chrome is stable, but fully scripted xterm touch input inside Android Chrome is still not a clean end-to-end automation path. Use `agent-browser` for inspection and targeted interactions, then finish with manual touch validation when xterm input automation gets flaky.
