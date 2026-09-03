# Changelog

All notable changes to T3 Code Status are recorded here.

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
