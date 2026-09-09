# T3 Code Status for OpenDeck

T3 Code Status adds an OpenDeck key that shows how many open T3 Code threads are working. `4/7` means that four of seven open threads currently have T3's `Starting` or `Working` state. Status arrives through a live stream; a full ring means the stream is connected. Press the key to retry an offline connection.

This is an unofficial community plugin. It is not part of T3 Code or OpenDeck.

## Install

The plugin needs Node.js 20 or newer installed on the host system. OpenDeck starts JavaScript plugins with this system-wide `node` executable. You do not need pnpm for a normal installation.

1. Start T3 Code and leave its server running.
2. Install `com.beastyrabbit.t3-code-status.streamDeckPlugin` through OpenDeck's plugin manager.
3. Drag `Thread status` from the `T3 Code Status` category onto a free key.
4. In T3 Code, open **Settings → Connections**. Enable **Network access** if the pairing controls are hidden, then create a **Read only** pairing link.
5. Paste the complete link into the key's **Pair an environment** field and choose **Pair / replace authorization**. Use the link within five minutes, without opening it elsewhere first.

Repeat pairing for each environment you want to monitor (up to 16). Connections are shared by all keys. Direct links and hosted `app.t3.codes` pairing links are accepted. Use HTTPS for remote connections; plain HTTP beyond loopback requires explicitly allowing it on your trusted private network.

Choose **Key display** in the key's settings:

- **Threads + questions** is the default. It shows the working/open thread count and adds a large blinking question mark while input, approval, or plan review is pending.
- **Threads only** shows the working/open thread count without question alerts.
- **Questions only** shows a faded question mark when nothing needs a response. When a thread needs input, approval, or plan review, the whole key flashes amber once per second and shows how many threads need you.

For two separate keys, drag `Thread status` onto two keys and select **Threads only** on one and **Questions only** on the other. Each key keeps its own display mode. Waiting threads, background monitoring, and errors alone do not trigger the question alert. Loading, offline, and connection errors still appear in every display mode.

Questions appear or clear when the stream delivers an update. There is no HTTP polling interval. Pressing a key does not answer or dismiss a question.

Transient connection failures retry with backoff up to 30 seconds. If any paired environment is disconnected, the key shows the connection state instead of presenting incomplete totals as live. When expired or revoked authorization prevents a connection, the key shows **LINK**: create a fresh read-only pairing link and paste it into the same settings panel. Re-pairing the same environment preserves your keys and replaces its credential. Current T3 bearer sessions expire after about 30 days; automatic authorization renewal is not available through this pairing flow. An existing stream may remain connected beyond that date because T3 checks authorization when the connection opens. Its next reconnect requires a fresh pairing link.

The normal plugin package declares these OpenDeck platforms:

| Operating system | Minimum version |
| --- | --- |
| Linux | OpenDeck's supported distributions |
| macOS | 10.15 |
| Windows | 10 |

Earlier releases were tested with OpenDeck 2.14.0 and a physical Stream Deck on Linux. The new pairing/stream connection is covered by local HTTP/WebSocket integration tests; those earlier hardware checks do not validate this new connection flow on Windows or macOS.

OpenDeck needs network access to each paired T3 server. For a Flatpak installation of OpenDeck on Linux, Node.js must be installed outside Flatpak and available on the system `PATH`. A Node.js Flatpak is not enough. Flatpak has not been tested yet.

## What the key shows

- Green at `7/7`: every open thread is working.
- Yellow near the midpoint: some threads are working and some are waiting.
- Red at `0/7`: none of the open threads is working.
- Gray at `0/0`: there are no open threads.

Intermediate values move from red through yellow to green. The plugin counts open threads from every paired environment's shell stream. Archived and settled threads do not count. Snoozed threads normally do not count; they reappear when they request approval or input, or when a fresh failure or completed turn after the snooze needs attention, provided they are otherwise still open. T3's `Starting` and `Working` states count as work. `Monitoring` counts as waiting.

OpenDeck also exposes the same changing status as the key's accessible label.

The former refresh-interval setting is no longer used. Each environment has one subscription regardless of how many keys use it.

## Optional automatic key placement on Linux

Installing the normal plugin package does not change an OpenDeck profile. The release also contains an optional Linux-only setup archive for users who want the plugin installed and the key placed automatically. This setup needs Node.js 20 or newer. On Windows and macOS, install the normal package and place the key in OpenDeck yourself.

1. Extract `com.beastyrabbit.t3-code-status-opendeck-setup.tar.gz`.
2. Quit OpenDeck completely.
3. Open a terminal in the extracted directory and run:

```bash
/usr/bin/node setup-opendeck.mjs
```

The setup installs the plugin and puts `Thread status` on the first free key in the `Default` profile. It backs up the profile before changing it and preserves the profile's file permissions. If the action already exists, the setup keeps its position and refresh interval and updates its accessibility settings when needed.

Keys created by an earlier version retain OpenDeck's old hidden-title setting when only the normal plugin package is upgraded. On Linux, quit OpenDeck and rerun the setup once to migrate an existing key. On Windows and macOS, remove the old key and add `Thread status` again. The visible key image works without this step, but OpenDeck cannot include its changing status in the accessible label until the profile setting is updated.

The setup uses `$XDG_CONFIG_HOME/opendeck` when `XDG_CONFIG_HOME` is an absolute path. Otherwise it uses `~/.config/opendeck`. Pass a different location explicitly when needed:

```bash
/usr/bin/node setup-opendeck.mjs --config /path/to/opendeck
```

For systems with multiple devices or profiles, use `--device <id>` and `--profile <name>`. `--dry-run` resolves and validates the destination without writing files. The setup refuses to continue while OpenDeck is running because OpenDeck could overwrite an external profile edit.

## Verify a release download

Download both archives and `SHA256SUMS` from the same immutable GitHub release. On Linux, check the files with:

```bash
sha256sum --check SHA256SUMS
```

macOS includes the equivalent command:

```bash
shasum -a 256 -c SHA256SUMS
```

On Windows, run this in PowerShell from the download directory:

```powershell
Get-Content .\SHA256SUMS | ForEach-Object {
  $expected, $file = $_ -split '\s+', 2
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash -ne $expected) {
    throw "Checksum mismatch: $file"
  }
}
```

GitHub CLI can then verify the signed build provenance on any platform:

```bash
gh attestation verify com.beastyrabbit.t3-code-status.streamDeckPlugin \
  --repo beastyrabbit/opendeck-t3-code-status \
  --signer-workflow beastyrabbit/opendeck-t3-code-status/.github/workflows/release.yml
```

Run the same `gh attestation verify` command for the setup archive if you use it. GitHub Actions signs the build provenance with a short-lived Sigstore certificate. Protected version tags bind each immutable release to the source commit that the workflow scanned.

## Connection and credential storage

The plugin exchanges the one-time pairing token for a bearer session with exactly `orchestration:read`, obtains short-lived WebSocket tickets, and subscribes to `orchestration.subscribeShell`. It does not read Chromium caches or import T3 account credentials. The read permission is broader than status-only access: it also permits reading files and conversations, though this plugin does not request them.

Credentials are stored separately from OpenDeck profiles and the plugin installation in `~/.config/opendeck-t3-code-status/connections.json`. The directory and file use owner-only permissions on Unix; Windows relies on the user's profile ACLs. This is a private credential file, not an encrypted vault. Do not share it. Pairing tokens are discarded after exchange, and credentials are never sent back to the settings panel or included in logs.

**Forget selected environment** removes its saved credential from this plugin. Revoke the corresponding session in **T3 Settings → Connections** to remove its server authorization too.

On reconnect the plugin checks the server's environment identity, gets a fresh ticket, and loads a fresh shell snapshot before continuing live updates. This also works with servers that lack optional replay-completion markers. Stream state stays in memory. Messages and retained thread counts are bounded.

This uses T3's existing first-party interface, which is not a versioned public SDK. Protocol reference: T3 Code commit `e16b8b059c9f5ff6dfed1addecffb831c6aee043`, following [the maintainer's guidance](https://github.com/pingdotgg/t3code/issues/10929#issuecomment-5601670045). Future T3 changes may require a plugin update.

The plugin uses a three-day age-based settlement default and does not import per-client sidebar preferences or pull-request state. Counts can differ from a T3 sidebar configured with other settlement rules.

## Build from source

Development checks require Node.js 22.13 or newer and pnpm 11. Release packaging also needs `zip`, `unzip`, and GNU `tar`, and currently runs on Linux. The packaged plugin runs on Node.js 20 or newer.

In T3 Code, open the Actions menu and import the checked-in entries under `From t3.json`. They cover worktree setup, verification, builds, and local OpenDeck deployment.

```bash
pnpm install
pnpm verify
pnpm package
```

`pnpm package` removes previous build output, rebuilds the plugin, and creates:

- `release/com.beastyrabbit.t3-code-status.streamDeckPlugin`
- `release/com.beastyrabbit.t3-code-status-opendeck-setup.tar.gz`

The package check builds each archive twice and fails unless both copies are byte-for-byte identical. It also verifies the manifest, version, required files, archive contents, bundled dependency notices, and the isolated setup path. It rejects the old cache reader in the runtime bundle and never touches the real OpenDeck configuration.

For a local Linux development update, OpenDeck may remain open:

```bash
pnpm deploy
```

`deploy` replaces only this plugin and asks OpenDeck to hot-reload it. It does not edit profiles. Both `deploy` and `setup:opendeck` are Linux-only. For the first automatic placement, quit OpenDeck and run `pnpm setup:opendeck` instead.

Elgato's validator does not recognize OpenDeck's `OS: linux` manifest entry. Packaging bypasses only that incompatible validator step, then verifies the complete archive itself.

## AI-assisted development

Codex in T3 Code was used extensively while writing the implementation, tests, and documentation. BeastyRabbit defined the behavior, reviewed the source, and tested the plugin with a real OpenDeck and T3 Code installation. Substantial AI assistance should be disclosed in contributions, and contributors must understand and verify every change they submit.

## License

MIT
