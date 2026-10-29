# Pairing T3 Code machines

Each T3 Code server shows only its own threads and accepts only tokens it issued itself, so the plugin needs one read-only token per machine, up to 16. All keys share the paired machines.

Tailscale makes machines reachable, but it does not authorize the plugin. Your T3 Code app shows every machine because it keeps a separate connection to each one, and other programs cannot use those connections.

## Pair one machine by hand

1. In T3 Code, open **Settings → Connections**. Enable **Network access** if the pairing controls are hidden, then create a **Read only** pairing link.
2. In OpenDeck, open the settings of any T3 Code Status key.
3. Paste the complete link into **Pair an environment** and select **Pair**. Use the link within five minutes, without opening it elsewhere first.

A pairing link belongs to the machine whose app creates it. To pair another machine by hand, create the link in that machine's own T3 Code app.

## Pair all your machines over SSH

If the machine that runs OpenDeck can already SSH into your other machines without a password prompt, the settings panel pairs them all at once:

1. Under **Pair machines over SSH**, select **Find**. The plugin runs `tailscale status --json` and asks each online device for `/.well-known/t3/environment` on port 3773, then at its Tailscale HTTPS address (`https://<device>.<tailnet>.ts.net`). It never connects over SSH for this. Machines that answer as T3 Code servers are added to the list. You can also type hosts yourself, such as `studio, buildbox, devbox:3774`.
2. Select **Pair all**. For each host, the plugin runs `t3 auth pairing create --scope orchestration:read --ttl 5m --json` over SSH, then pairs the returned token with the T3 server at `http://<host>:3773`, or at the machine's Tailscale HTTPS address when that port does not answer. The token is never shown or logged.
3. Read the result below the button: one line with the paired machines, and one line for each machine that failed.

### How Pair all reaches each machine

- **SSH user and keys** come from your `~/.ssh/config`. When a Tailscale name, such as `my-mac-mini`, has no entry there, **Pair all** uses the alias whose `HostName` is that device's Tailscale address or current LAN address, such as `macmini` at `192.168.1.20`. The LAN match works only while the device is on the same LAN as OpenDeck. For a laptop that travels, add a `Host` entry for its Tailscale name with the right `User`, and make sure its `authorized_keys` accepts your key from Tailscale addresses.
- **The `t3` command** is looked up on the `PATH` and in `~/.local/bin` and `~/.t3/bin`, because non-interactive SSH shells, such as on macOS, often lack those folders. Windows T3 Code ships no `t3` command, so on Windows **Pair all** runs the same command through the installed `T3 Code (Beta).exe`.
- **Network access:** each machine's T3 server must accept connections from the network, either on port 3773 or through Tailscale HTTPS (`tailscale serve`), the way the T3 Code app reaches it. A server that listens only on `127.0.0.1` with neither is not found by **Find** and cannot be paired. Turn on **Network access** in that machine's T3 Code settings first.
- **Tailscale HTTPS fallback:** when a paired machine stops answering on its plain-HTTP address, for example because its T3 server restarted listening only on `127.0.0.1`, the plugin tries the machine's Tailscale HTTPS address with the same login. It switches only after the same T3 server answers there, The new address is saved the next time you pair or remove a machine, for example with **Pair all**; until then the plugin finds it again after each restart.
- **Plain HTTP:** hosts that resolve only to Tailscale addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) pair over plain HTTP without the **Allow plain HTTP outside Tailscale** opt-in, because Tailscale already encrypts that traffic. The plugin then pairs the machine at its Tailscale address, so a later DNS answer, for example while Tailscale is off, cannot send its credentials over the LAN. This applies to **Pair all** and to links pasted into **Pair**. Other plain-HTTP hosts need the opt-in. **Pair** also accepts direct links and hosted `app.t3.codes` pairing links.

### When Pair all reports a failure

| Result | What to do |
| --- | --- |
| SSH login failed | Run `ssh <host> true` from the OpenDeck machine. Accept the host key once, and make sure the login works without a password prompt. |
| No working t3 command over SSH | Check that T3 Code 0.1 or newer is installed there, and that `t3 --version` works in that user's SSH session. |
| T3 Code not reachable | Turn on **Network access** in that machine's T3 Code settings, or check that its Tailscale HTTPS address opens T3 Code. |
| Allow unencrypted HTTP to pair it | The host is not on Tailscale. Use HTTPS, or check **Allow plain HTTP outside Tailscale** if you trust the network. |

## Renewing and removing pairings

T3 authorizations expire after about 30 days, and the plugin cannot renew them on its own. A connected stream may stay open past that date because T3 checks authorization only when a connection opens; the next reconnect then shows **RE-PAIR**.

- For machines paired over SSH, select **Pair all** again. The list keeps every machine that is already paired, so one press renews them all.
- For machines paired by hand, create a fresh read-only link in that machine's T3 Code app and paste it into **Pair an environment**.

**Forget selected environment** removes the saved credential from the plugin. To remove the server's authorization too, revoke the session in **T3 Settings → Connections** on that machine.
