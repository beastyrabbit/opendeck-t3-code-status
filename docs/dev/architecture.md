# Architecture

The plugin is a Node.js process that OpenDeck starts. It keeps one live connection to each paired T3 Code server, turns their threads into counts, and draws each key as an SVG image.

```
OpenDeck  ⇄  opendeck.ts  ⇄  controller.ts  ⇄  t3-live-client.ts  ⇄  T3 Code servers
                                  │                    │
                              render.ts            status.ts, t3-protocol.ts, connection-store.ts
                                  │
                  ssh-pairing.ts, tailnet.ts (Pair all, Find)
```

## Modules

| File | Role |
| --- | --- |
| `src/index.ts` | Entry point. Wires the OpenDeck host to the controller and the live client. |
| `src/opendeck.ts` | The Stream Deck plugin protocol that OpenDeck speaks over WebSocket: launch arguments, events in, images and titles out. Bounds every value it keeps from the host. |
| `src/controller.ts` | Tracks visible keys and open settings panels, renders on every status change, runs the blink animation, and handles settings-panel commands (`pair`, `pairSsh`, `discoverHosts`, `removeConnection`, `getConnectionStatus`). |
| `src/t3-live-client.ts` | One WebSocket per paired environment. Pairs, reconnects with backoff (moving a plain-HTTP connection that stops answering to the machine's Tailscale HTTPS address once the same environment answers there), keeps each environment's threads in memory, and sums the per-environment counts into one snapshot. |
| `src/t3-protocol.ts` | Parses T3's wire format: pairing links, origins, the environment descriptor, and thread shells. Keeps only the fields the keys need, never conversation or file data. |
| `src/status.ts` | Classifies each thread and counts them into a `ThreadSummary`. |
| `src/render.ts` | Draws every key type, theme, and connection state as SVG, and writes the accessible titles. |
| `src/connection-store.ts` | Reads and writes `~/.config/opendeck-t3-code-status/connections.json` with owner-only permissions. |
| `src/ssh-pairing.ts` | Creates read-only pairing tokens over SSH with a fixed remote command, including the Windows fallback. Reads SSH config aliases. |
| `src/tailnet.ts` | **Find**: lists Tailscale peers and probes them for a T3 server on port 3773 or at their Tailscale HTTPS address. Decides when plain HTTP is safe, pins Tailscale pairings to their address, and looks up the HTTPS address used when a plain-HTTP server stops answering. |
| `src/types.ts` | Shared types, action UUIDs, display modes, themes, and settings normalization. |
| `plugin/` | The static plugin: `manifest.json`, icons, and the settings panel (`property-inspector/`), plain JavaScript that talks to the controller through `sendToPlugin`. |
| `scripts/` | Build, package, release verification, local deployment, the Linux setup, and the docs images. |

## Connection flow

For each paired environment, `T3LiveClient`:

1. Pairs once: reads `/.well-known/t3/environment`, exchanges the one-time token at `/oauth/token` for a bearer token, confirms at `/api/auth/session` that its only scope is `orchestration:read`, and saves it.
2. On every connect, checks the environment descriptor again (identity and orchestration protocol 2), gets a ticket from `/api/auth/websocket-ticket`, and opens `/ws` with that ticket.
3. Subscribes to `orchestration.subscribeShell`, loads the full snapshot, then applies `thread.updated` and `thread.removed` events.

Environments that are offline are left out of the counts instead of blanking every key. Only when none is connected do the keys show **OFF**, **RE-PAIR**, or **VERSION**. Change notifications are batched for 50 ms, and a 30-second clock re-evaluates snoozes without network traffic.

## Counting rules

`status.ts` mirrors T3 Code's own client, so the keys agree with the T3 sidebar. The upstream sources are named at the top of the file: `packages/client-runtime` (`models.ts`, `threadSettled.ts`) and `packages/shared` (`agentAwareness.ts`). When T3 changes its sidebar rules, update `status.ts` and its tests together.

`classifyThread` gives each thread exactly one state, in this order: approval, input, plan, limited, failed, starting, working, monitoring, waiting. `summarizeSnapshot` then adds counts that cut across states:

- `running` is `starting` plus `working`.
- `blocked` is the part of `running` that only waits on another thread or on awaited background work. The Overview draws `running - blocked` as the big number and `blocked` as the ⏸ count.
- `background` counts threads with any background task.
- `unseen` counts idle threads whose latest run finished after the user last opened them.

`isRelevantThread` decides what counts at all: archived threads, subagents, and snoozed or settled threads without pending work are left out.

## Rendering

Every key is a 144 × 144 SVG returned as a data URI. Each theme is a `ThemeRenderer` with four entry points: `combined` (Thread status in Combined mode), `single` (one status), `overview`, and `connection`. Every colour has its own shape, so no state relies on colour alone. Geometry follows `mockups/key-mockups.html`, the design study the themes came from.

Blinking keys alternate between two frames; the controller re-renders them every 500 ms. The Overview never blinks.

## Constraints

- **Action UUIDs are historical.** **Thread status** is `com.beastyrabbit.t3-code-status.overview` and **Overview** is `…overview-tile`. Renaming them would orphan every placed key.
- **Manifest changes need an OpenDeck restart.** `pnpm deploy` hot-reloads code, but new or removed actions only appear after OpenDeck itself restarts.
- **`refreshSeconds` is legacy.** Settings still carry it so older profiles load, but the live stream made it unused.
