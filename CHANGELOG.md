# Changelog

All notable changes to T3 Code Status are recorded here.

## Unreleased

- The Overview key's running cell now shows the actively working threads as its big number, next to the ⏸ count of those that only wait. The two add up to the running total instead of the waiting count reading as extra threads.
- Move the user guide into `docs/user/` with pictures of every key type, theme, and connection state, rendered from the plugin itself. Add developer documentation in `docs/dev/`.

## 0.4.0

- Redesign the keys for 2 cm displays: one large number or symbol per key, and a distinct shape for every status colour.
- Add separate key types for working threads, all requests, approvals, questions, plan reviews, failures, usage limits, background tasks, and waiting threads. Existing "Threads only" and "Questions only" keys become Working and Needs you keys.
- Add five themes for every key type: Counter, Pictogram, Flood, Gauge, and Quad.
- Add an **Overview** action: one key that shows running threads (and how many of them only wait), requests for you, finished threads you have not opened yet, and errors at once, in every theme. It never blinks. The Quad theme's Thread status key now switches to the most urgent state like the other themes.
- The Thread status key shows finished threads you have not opened yet, after requests, failures, and usage limits. Background tasks are now grey; cyan marks finished, unseen threads.
- A paired machine that is offline no longer turns every key **OFF**: the keys count the machines they can reach, and the settings panel names the ones left out.
- Add **Pair machines over SSH**: one button creates a read-only pairing token on each listed machine through `ssh` and its `t3` command and pairs it, without showing the token. Pressing it again renews every expired authorization.
- Add **Find**, which lists the machines on your Tailscale network that run T3 Code. Hosts on Tailscale addresses pair over HTTP without the unencrypted-HTTP opt-in, at their Tailscale address.
- **Pair all** reaches Tailscale devices through the matching SSH alias, finds `t3` in `~/.local/bin` and `~/.t3/bin`, and pairs Windows machines through the T3 Code app's own CLI.
- Lay out the key settings side by side for OpenDeck's wide settings strip, with larger text and the pairing notes folded away.
- Count failures caused by a provider usage limit as usage limits, and count finished threads as not seen even when the server omits their completion time, as T3 Code does.
- Show distinct PAIR, RE-PAIR, and VERSION states for missing pairing, expired authorization, and unsupported T3 versions.
- Support T3 Code 0.1 and its orchestration protocol 2. The plugin declares the protocol when it connects and parses the V2 thread shell stream. Earlier plugin builds cannot read T3 Code 0.1 and show an error.
- Derive working, approval, question, plan, failure, and background states with the same rules as T3 Code's client. Usage-limit pauses are tracked separately, and a live subagent's approval now flags its parent thread.
- Leave settlement to T3 Code's server-side auto-settlement instead of applying a local three-day rule.
- Report an unsupported T3 version distinctly instead of a generic connection error.
- Remove the unused local-cache reader and its `snappyjs` dependency.

## 0.2.1

- Read T3 Code caches that use V8 serialization format 16 while retaining support for format 15.
- Retry every five seconds while T3 Code is offline or its cache cannot be read, then return to the configured refresh interval after recovery.

## 0.2.0

- Read thread state from T3 Code's local shell cache without accounts, pairing, or credentials.
- Count open top-level threads across all environments and distinguish working from waiting states.
- Add a 60-second refresh ring, manual refresh, and a 5-to-300-second interval setting.
- Bound LevelDB, OpenDeck event, Property Inspector, and setup inputs.
- Add reproducible release archives with signed build provenance, OpenDeck hot deployment, and optional automatic key placement.
- Let OpenDeck install the normal plugin package on Linux, macOS, and Windows. CI runs checks on all three; automatic profile setup and hot deployment remain Linux-only.
- Read Chromium's external IndexedDB value blobs, including the format used by current T3 Code builds on macOS.
- Handle the different device IDs that Node reports for the same open cache file on Windows.
- Reject non-regular runtime, settings, OpenDeck setup, database, and blob files without blocking.
- Expose the live key status to assistive technology without drawing a second title. The Linux setup migrates existing keys while preserving their position and settings.
- Avoid repeating unchanged Property Inspector status announcements during refreshes.
