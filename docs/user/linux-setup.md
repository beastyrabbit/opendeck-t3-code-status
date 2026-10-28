# Automatic key placement on Linux

Installing the normal plugin package does not change an OpenDeck profile. Each release also contains an optional Linux-only setup archive that installs the plugin and places a key for you. It needs Node.js 20 or newer. On Windows and macOS, install the normal package and place the key in OpenDeck yourself.

1. Extract `com.beastyrabbit.t3-code-status-opendeck-setup.tar.gz`.
2. Quit OpenDeck completely.
3. Open a terminal in the extracted directory and run:

```bash
/usr/bin/node setup-opendeck.mjs
```

The setup installs the plugin and puts **Thread status** on the first free key in the `Default` profile. It backs up the profile before changing it and preserves the profile's file permissions. If the action already exists, the setup keeps its position and updates its accessibility settings when needed.

The setup uses `$XDG_CONFIG_HOME/opendeck` when `XDG_CONFIG_HOME` is an absolute path, and `~/.config/opendeck` otherwise. Pass a different location explicitly when needed:

```bash
/usr/bin/node setup-opendeck.mjs --config /path/to/opendeck
```

For systems with several devices or profiles, use `--device <id>` and `--profile <name>`. `--dry-run` resolves and validates the destination without writing files. The setup refuses to run while OpenDeck is running, because OpenDeck could overwrite the profile edit.

## Keys from earlier versions

Keys created by an earlier version keep OpenDeck's old hidden-title setting when only the normal plugin package is upgraded. The key image works without changes, but OpenDeck cannot include the changing status in the key's accessible label until that setting is updated.

- On Linux, quit OpenDeck and run the setup once to migrate existing keys.
- On Windows and macOS, remove the old key and add **Thread status** again.
