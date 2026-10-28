import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	type CommandResult,
	issuePairingLink,
	parseSshHosts,
	readSshConfigAliases,
} from "../src/ssh-pairing.js";
import { LiveConnectionError } from "../src/t3-protocol.js";

function runner(result: CommandResult) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const run = async (command: string, args: string[]) => {
		calls.push({ command, args });
		return result;
	};
	return { calls, run };
}

function rejectsWith(code: string) {
	return (error: unknown) => error instanceof LiveConnectionError && error.code === code;
}

test("host lists split on commas and spaces, drop repeats, and reject anything ssh could read as an option", () => {
	assert.deepEqual(parseSshHosts(" anvil, kiln  devbox:3774,anvil "), ["anvil", "kiln", "devbox:3774"]);
	for (const value of ["", " , ", "-oProxyCommand=touch", "anvil;reboot", "user@anvil", "anvil:", "a$(b)"])
		assert.throws(() => parseSshHosts(value), rejectsWith("invalid-host"), value);
	assert.throws(
		() => parseSshHosts(Array.from({ length: 17 }, (_, index) => `host${index}`).join(",")),
		rejectsWith("invalid-host"),
	);
});

test("the pairing link comes from a fixed read-only t3 command and points at the host's T3 port", async () => {
	const { calls, run } = runner({ code: 0, stdout: JSON.stringify({ id: "1", credential: "fixture" }) });
	const link = await issuePairingLink("anvil", undefined, run);
	assert.equal(link, "http://anvil:3773/pair#token=fixture");
	assert.equal(calls[0]?.command, "ssh");
	const args = calls[0]?.args ?? [];
	assert.deepEqual(args.slice(-3, -1), ["--", "anvil"]);
	const remote = args.at(-1) ?? "";
	assert.match(remote, /\$HOME\/\.t3\/runtime\/service-state\.json/);
	assert.match(
		remote,
		/PATH="\$PATH:\$HOME\/\.local\/bin:\$HOME\/\.t3\/bin" "\$t3" auth pairing create --scope orchestration:read --ttl 5m .*--json$/,
	);
	assert.ok(args.includes("BatchMode=yes"));
	assert.equal(
		await issuePairingLink("devbox:3774", undefined, run),
		"http://devbox:3774/pair#token=fixture",
	);
	assert.deepEqual(calls[1]?.args.slice(-3, -1), ["--", "devbox"]);
	assert.equal(await issuePairingLink("mac-mini", "macmini", run), "http://mac-mini:3773/pair#token=fixture");
	assert.deepEqual(calls[2]?.args.slice(-3, -1), ["--", "macmini"]);
});

test("SSH config aliases include literal Host names from included files and skip patterns", async () => {
	const folder = await mkdtemp(join(tmpdir(), "ssh-config-"));
	try {
		await writeFile(
			join(folder, "fleet"),
			"Host macstudio macmini\n  HostName 192.168.1.59\nHost *.lan !bad\n",
		);
		await writeFile(
			join(folder, "config"),
			`Include ${join(folder, "fleet")}\nInclude ${join(folder, "missing")}\nHost=github.com\nHost *\n  User beasty\n`,
		);
		assert.deepEqual(await readSshConfigAliases(join(folder, "config")), [
			"macstudio",
			"macmini",
			"github.com",
		]);
		assert.deepEqual(await readSshConfigAliases(join(folder, "absent")), []);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
});

test("machines without a t3 command get the Windows app's CLI as a second try", async () => {
	const commands: string[] = [];
	const link = await issuePairingLink("windows-pc", undefined, async (_command, args) => {
		commands.push(args.at(-1) ?? "");
		return commands.length === 1
			? { code: 1, stdout: "" }
			: { code: 0, stdout: JSON.stringify({ credential: "fixture" }) };
	});
	assert.equal(link, "http://windows-pc:3773/pair#token=fixture");
	assert.match(
		commands[1] ?? "",
		/^set ELECTRON_RUN_AS_NODE=1&& ".*T3 Code \(Beta\)\.exe" ".*bin\.mjs" auth pairing create --scope orchestration:read /,
	);
});

test("ssh and t3 failures map to codes the settings panel explains", async () => {
	await assert.rejects(
		issuePairingLink("anvil", undefined, runner({ code: 255, stdout: "" }).run),
		rejectsWith("ssh-failed"),
	);
	await assert.rejects(
		issuePairingLink("anvil", undefined, runner({ code: 127, stdout: "" }).run),
		rejectsWith("t3-missing"),
	);
	await assert.rejects(
		issuePairingLink("anvil", undefined, runner({ code: 1, stdout: "" }).run),
		rejectsWith("t3-failed"),
	);
	await assert.rejects(
		issuePairingLink("anvil", undefined, runner({ code: 0, stdout: "Token: x" }).run),
		rejectsWith("t3-failed"),
	);
	await assert.rejects(
		issuePairingLink("anvil", undefined, runner({ code: 0, stdout: "{}" }).run),
		rejectsWith("t3-failed"),
	);
});
