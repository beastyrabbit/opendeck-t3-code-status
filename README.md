# T3 Code Status for OpenDeck

T3 Code Status adds one OpenDeck key that shows how many open T3 Code threads are working. `4/7` means that four of seven open threads currently have T3's `Starting` or `Working` state. The ring advances toward the next cache read. Press the key to refresh immediately.

This is an unofficial community plugin. It is not part of T3 Code or OpenDeck.

## Install

The plugin needs Node.js 20 or newer installed on the host system. OpenDeck starts JavaScript plugins with this system-wide `node` executable. You do not need pnpm for a normal installation.

1. Start T3 Code Alpha at least once, then leave it open so the cache stays current.
2. Install `com.beastyrabbit.t3-code-status.streamDeckPlugin` through OpenDeck's plugin manager.
3. Drag `Thread status` from the `T3 Code Status` category onto a free key.

The first cache read starts immediately. Further reads run every 60 seconds by default.

The following combination is currently supported and tested:

| Component | Version |
| --- | --- |
| Operating system | Linux |
| OpenDeck | 2.14.0 |
| T3 Code | Alpha 0.0.36 |
| Node.js | 20 or newer |

OpenDeck and T3 Code must run as the same Linux user and use the same home directory. For a Flatpak installation of OpenDeck, Node.js must be installed outside Flatpak and available on the system `PATH`. A Node.js Flatpak is not enough. Other OpenDeck and T3 Code versions, as well as Flatpak installations, have not been tested yet.

## What the key shows

- Green at `7/7`: every open thread is working.
- Yellow near the midpoint: some threads are working and some are waiting.
- Red at `0/7`: none of the open threads is working.
- Gray at `0/0`: there are no open threads.

Intermediate values move from red through yellow to green. The plugin counts open top-level threads from every environment in T3 Code's local cache. Child agents, archived threads, and settled threads do not count. Snoozed threads normally do not count; they reappear when they request approval or input, or when a fresh failure or completed turn after the snooze needs attention, provided they are otherwise still open. T3's `Starting` and `Working` states count as work. `Monitoring` counts as waiting.

The Property Inspector accepts refresh intervals from 5 to 300 seconds. Its default is 60 seconds.

## Optional automatic key placement

Installing the normal plugin package does not change an OpenDeck profile. The release also contains an optional setup archive for users who want the plugin installed and the key placed automatically. This setup needs Node.js 20 or newer.

1. Extract `com.beastyrabbit.t3-code-status-opendeck-setup.tar.gz`.
2. Quit OpenDeck completely.
3. Open a terminal in the extracted directory and run:

```bash
/usr/bin/node setup-opendeck.mjs
```

The setup installs the plugin and puts `Thread status` on the first free key in the `Default` profile. It backs up the profile before changing it and preserves the profile's file permissions. If the action already exists, its position and refresh interval remain unchanged.

On Linux, the setup uses `$XDG_CONFIG_HOME/opendeck` when `XDG_CONFIG_HOME` is an absolute path. Otherwise it uses `~/.config/opendeck`. Pass a different location explicitly when needed:

```bash
/usr/bin/node setup-opendeck.mjs --config /path/to/opendeck
```

For systems with multiple devices or profiles, use `--device <id>` and `--profile <name>`. `--dry-run` resolves and validates the destination without writing files. The setup refuses to continue while OpenDeck is running because OpenDeck could overwrite an external profile edit.

## Verify a release download

Download both archives and `SHA256SUMS` from the same immutable GitHub release. Check the files before installing them:

```bash
sha256sum --check SHA256SUMS
gh attestation verify com.beastyrabbit.t3-code-status.streamDeckPlugin \
  --repo beastyrabbit/opendeck-t3-code-status \
  --signer-workflow beastyrabbit/opendeck-t3-code-status/.github/workflows/release.yml
```

Run the same `gh attestation verify` command for the setup archive if you use it. GitHub Actions signs the build provenance with a short-lived Sigstore certificate. Protected version tags bind each immutable release to the source commit that the workflow scanned.

## How local cache access works

T3 Code stores a compact shell snapshot for every connected environment in its local Chromium cache. The plugin calls T3 Code's loopback environment endpoint to select the active T3 profile, then reads those snapshots directly. It does not need a T3 account, pairing code, access token, or separate server.

The plugin discovers the current `t3code` user-data directory as well as the legacy `T3 Code`, `T3 Code (Alpha)`, `T3 Code (Beta)`, and other `T3 Code (<channel>)` directories. If T3 Code uses a custom Electron data directory, set `T3CODE_CACHE_DIR` to the exact `IndexedDB/t3code_app_0.indexeddb.leveldb` directory.

The plugin does not interpret message, title, or prompt records. Chromium stores several object stores in the same LevelDB files, so the reader briefly holds bounded file data in memory before it filters out every non-shell record. It does not retain, log, or transmit those contents, and it does not copy thread IDs into its own files or logs. If T3 Code is not running or has not created a cache yet, the key shows `OFF` or `ERR`, and the Property Inspector explains the state.

To keep malformed cache data from exhausting the OpenDeck plugin process, the reader limits files, profiles, records, table blocks, decompressed blocks, shell keys, serialized snapshots, and estimated parser allocations. A single LevelDB file may not exceed 64 MB. The key shows `ERR` when a limit is exceeded.

Pull requests are one known limitation. T3 Code keeps a pull request's open, closed, or merged state in its live renderer but does not include it in the local shell snapshot. This plugin therefore uses only the settlement state available in the cache. A thread whose automatic settlement depends only on a pull request may remain in the denominator for a while. The plugin deliberately does not request GitHub or T3 credentials to close that gap.

## Build from source

Development requires Node.js 22.13 or newer, pnpm 11, `zip`, `unzip`, and GNU `tar`. The packaged plugin runs on Node.js 20 or newer.

In T3 Code, open the Actions menu and import the checked-in entries under `From t3.json`. They cover worktree setup, verification, builds, and local OpenDeck deployment.

```bash
pnpm install
pnpm verify
pnpm package
```

`pnpm package` removes previous build output, rebuilds the plugin, and creates:

- `release/com.beastyrabbit.t3-code-status.streamDeckPlugin`
- `release/com.beastyrabbit.t3-code-status-opendeck-setup.tar.gz`

The package check builds each archive twice and fails unless both copies are byte-for-byte identical. It also verifies the manifest, version, required files, archive contents, bundled dependency notices, and the isolated setup path. It rejects markers from the discarded pairing implementation and never touches the real OpenDeck configuration.

For a local development update, OpenDeck may remain open:

```bash
pnpm deploy
```

`deploy` replaces only this plugin and asks OpenDeck to hot-reload it. It does not edit profiles. For the first automatic placement, quit OpenDeck and run `pnpm setup:opendeck` instead.

Elgato's validator does not recognize Linux plugin fields and reports `CodePathLin` and `OS: linux` as errors. OpenDeck requires those fields. Packaging bypasses only that incompatible validator step, then verifies the complete archive itself.

## AI-assisted development

Codex in T3 Code was used extensively while writing the implementation, tests, and documentation. BeastyRabbit defined the behavior, reviewed the source, and tested the plugin with a real OpenDeck and T3 Code installation. Substantial AI assistance should be disclosed in contributions, and contributors must understand and verify every change they submit.

## License

MIT
