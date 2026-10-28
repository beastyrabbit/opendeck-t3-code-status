# Security and privacy

## What the plugin can read

The plugin exchanges the one-time pairing token for a bearer session with exactly the `orchestration:read` scope, obtains short-lived WebSocket tickets, and subscribes to T3's thread shell stream (`orchestration.subscribeShell`). It does not read Chromium caches or import T3 account credentials.

T3 has no status-only permission. `orchestration:read` also allows reading files and conversations, though this plugin never requests them and keeps only the fields the keys need. Stream state stays in memory, and the number of messages and threads it keeps is bounded.

On every reconnect the plugin checks the server's environment identity, gets a fresh ticket, and loads a fresh thread snapshot before it continues with live updates.

The connection uses T3's own first-party interface, which is not a versioned public SDK. The plugin targets T3 Code 0.1 with orchestration protocol 2, following [the maintainer's guidance](https://github.com/pingdotgg/t3code/issues/10929#issuecomment-5601670045). Future T3 changes may need a plugin update.

## Where credentials are stored

Credentials are stored in `~/.config/opendeck-t3-code-status/connections.json`, separate from OpenDeck profiles and the plugin installation, so profile exports and plugin upgrades never carry them. On Unix the directory and file are readable only by you; Windows relies on the user profile's permissions.

This is a private credential file, not an encrypted vault. Do not share it. Pairing tokens are discarded after the exchange, and credentials are never sent back to the settings panel or written to logs.

See [Renewing and removing pairings](pairing.md#renewing-and-removing-pairings) to remove a credential.

## Verify a release download

Download both archives and `SHA256SUMS` from the same GitHub release. On Linux, check the files with:

```bash
sha256sum --check SHA256SUMS
```

On macOS:

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

Run the same command for the setup archive if you use it. GitHub Actions signs the provenance with a short-lived Sigstore certificate, and protected version tags bind each immutable release to the source commit the workflow scanned.

## Report a vulnerability

See the [security policy](../../SECURITY.md).
