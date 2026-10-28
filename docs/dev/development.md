# Development

## Requirements

- Node.js 22.13 or newer and pnpm 11 for development. The packaged plugin itself runs on Node.js 20 or newer.
- `zip`, `unzip`, and GNU `tar` for release packaging, which currently runs on Linux.
- Linux and a local OpenDeck for `pnpm deploy` and `pnpm setup:opendeck`.

In T3 Code, the Actions menu can import the checked-in entries under `From t3.json`: worktree setup, verification, build, and local OpenDeck deployment.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs dependencies and the lefthook pre-commit hooks (gitleaks and `pnpm verify`). |
| `pnpm verify` | Type-check, Biome lint, tests, and build. Run it before handing off a change. |
| `pnpm test` | The `node:test` suites in `tests/`. |
| `pnpm format` | Formats with Biome. |
| `pnpm build` | Bundles the plugin into `dist/com.beastyrabbit.t3-code-status.sdPlugin`. |
| `pnpm deploy` | Builds, replaces only this plugin in the local OpenDeck, and asks OpenDeck to hot-reload it. It never edits profiles. |
| `pnpm setup:opendeck` | Builds and runs the Linux setup: installs the plugin and places a key. Quit OpenDeck first. |
| `pnpm package` | Builds the release archives into `release/`. |
| `pnpm package:verify` | Checks existing release archives. |
| `pnpm docs:images` | Regenerates the key pictures in `docs/user/images/` from the renderer. |

## Trying a change on real keys

`pnpm deploy` hot-reloads the plugin into a running OpenDeck. New or removed actions in `plugin/manifest.json` only appear after OpenDeck itself restarts.

If OpenDeck was upgraded by the package manager while it kept running, the reload command can fail and `deploy` restores the previous plugin files. Restart OpenDeck and deploy again.

## Tests

Tests use `node:test` with fakes for OpenDeck, T3 servers, SSH, and Tailscale; they never touch the real OpenDeck configuration or call real machines. Add tests with every behaviour change, and keep real credentials and private thread data out of fixtures.

When you change how a key looks, run `pnpm docs:images` and commit the updated pictures. A test fails while they differ from the renderer.

## Packaging

`pnpm package` removes previous build output, rebuilds the plugin, and creates:

- `release/com.beastyrabbit.t3-code-status.streamDeckPlugin`
- `release/com.beastyrabbit.t3-code-status-opendeck-setup.tar.gz`

The package check builds each archive twice and fails unless both copies are byte-for-byte identical. It also verifies the manifest, version, required files, archive contents, bundled dependency notices, and the isolated setup path, and rejects the old local-cache reader in the runtime bundle.

Elgato's validator does not recognize OpenDeck's `OS: linux` manifest entry. Packaging skips only that incompatible validator step and then verifies the complete archive itself.

## CI and releases

- **CI** (`.github/workflows/ci.yml`) scans the source and history with gitleaks, runs `pnpm verify` and `pnpm package`, scans the release payloads, and reruns the tests on Node.js 20. It also type-checks, lints, tests, and builds on macOS and Windows.
- **Release** (`.github/workflows/release.yml`) runs on a `v*` tag. It repeats those checks, confirms the tag matches the package version, records checksums, attests build provenance, and creates a verified release **draft**. Publishing the draft is a manual step.

Record user-visible changes in `CHANGELOG.md`.

## Architecture

See [architecture.md](architecture.md) for the modules, the connection flow, the counting rules, and rendering.
