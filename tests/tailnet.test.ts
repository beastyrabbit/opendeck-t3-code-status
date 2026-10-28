import assert from "node:assert/strict";
import { test } from "node:test";

import {
	discoverTailnetHosts,
	isTailnetHost,
	matchSshTarget,
	sshPairingIssuer,
	type TailnetPeer,
} from "../src/tailnet.js";

const STATUS = JSON.stringify({
	Self: { DNSName: "desk.example.ts.net.", Online: true },
	Peer: {
		a: { DNSName: "anvil.example.ts.net.", Online: true },
		b: { DNSName: "homedash.example.ts.net.", Online: true },
		c: { DNSName: "kiln.example.ts.net.", Online: false },
		d: { DNSName: "mac-mini.example.ts.net.", Online: true },
		e: { DNSName: "-oProxyCommand.example.ts.net.", Online: true },
	},
});

test("discovery probes online peers and returns the ones running T3 by their short name", async () => {
	const probed: string[] = [];
	const hosts = await discoverTailnetHosts(
		async (command, args) => {
			assert.deepEqual([command, ...args], ["tailscale", "status", "--json"]);
			return { code: 0, stdout: STATUS };
		},
		async (origin) => {
			probed.push(origin);
			if (origin.includes("mac-mini")) throw new Error("timeout");
			return origin.includes("anvil");
		},
	);
	assert.deepEqual(probed, [
		"http://anvil.example.ts.net:3773",
		"http://homedash.example.ts.net:3773",
		"http://mac-mini.example.ts.net:3773",
	]);
	assert.deepEqual(hosts, ["anvil"]);
});

test("discovery finds nothing when Tailscale is missing or prints something unexpected", async () => {
	const probe = async () => true;
	assert.deepEqual(await discoverTailnetHosts(async () => ({ code: 255, stdout: "" }), probe), []);
	assert.deepEqual(await discoverTailnetHosts(async () => ({ code: 0, stdout: "not json" }), probe), []);
	assert.deepEqual(await discoverTailnetHosts(async () => ({ code: 0, stdout: "{}" }), probe), []);
});

test("only names that resolve entirely to Tailscale addresses count as encrypted", async () => {
	const resolveTo =
		(...addresses: string[]) =>
		async () =>
			addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
	assert.equal(await isTailnetHost("anvil", resolveTo("100.80.1.1")), true);
	assert.equal(await isTailnetHost("anvil", resolveTo("100.80.1.1", "fd7a:115c:a1e0::1")), true);
	assert.equal(await isTailnetHost("anvil", resolveTo("100.80.1.1", "192.168.1.5")), false);
	assert.equal(await isTailnetHost("anvil", resolveTo("100.128.0.1")), false);
	assert.equal(await isTailnetHost("anvil", resolveTo()), false);
	assert.equal(
		await isTailnetHost("anvil", async () => {
			throw new Error("ENOTFOUND");
		}),
		false,
	);
});

const MAC_MINI: TailnetPeer = {
	name: "mac-mini",
	dnsName: "mac-mini.example.ts.net",
	addresses: ["100.90.1.2", "192.168.1.56"],
};

test("tailnet hosts without an SSH alias of their own use the alias that points at the same machine", () => {
	const aliases = new Map([
		["macmini", "192.168.1.56"],
		["anvil", "anvil"],
		["macstudio", "192.168.1.59"],
	]);
	assert.equal(matchSshTarget("mac-mini", aliases, [MAC_MINI]), "macmini");
	assert.equal(matchSshTarget("mac-mini.example.ts.net", aliases, [MAC_MINI]), "macmini");
	assert.equal(matchSshTarget("anvil", aliases, [MAC_MINI]), undefined);
	assert.equal(matchSshTarget("kiln", aliases, [MAC_MINI]), undefined);
	assert.equal(matchSshTarget("mac-mini", new Map([["macstudio", "192.168.1.59"]]), [MAC_MINI]), undefined);
});

test("the SSH pairing issuer reads the alias table once per batch and connects through the matching alias", async () => {
	const calls: string[][] = [];
	let time = 0;
	const issue = sshPairingIssuer(
		async (command, args) => {
			calls.push([command, ...args]);
			if (command === "tailscale")
				return {
					code: 0,
					stdout: JSON.stringify({
						Peer: {
							m: {
								DNSName: "mac-mini.example.ts.net.",
								Online: true,
								TailscaleIPs: ["100.90.1.2"],
								CurAddr: "192.168.1.56:41641",
							},
						},
					}),
				};
			if (args[0] === "-G")
				return { code: 0, stdout: `user x\nhostname ${args[2] === "macmini" ? "192.168.1.56" : args[2]}\n` };
			return { code: 0, stdout: JSON.stringify({ credential: "fixture" }) };
		},
		() => time,
		async () => ["macmini", "anvil"],
	);
	assert.equal(await issue("mac-mini"), "http://mac-mini:3773/pair#token=fixture");
	assert.equal(await issue("anvil"), "http://anvil:3773/pair#token=fixture");
	const pairings = calls.filter((call) => call[0] === "ssh" && call[1] !== "-G");
	assert.deepEqual(
		pairings.map((call) => call.at(-2)),
		["macmini", "anvil"],
	);
	assert.equal(calls.filter((call) => call[0] === "tailscale").length, 1);
	time = 60_000;
	await issue("anvil");
	assert.equal(calls.filter((call) => call[0] === "tailscale").length, 2);
});
