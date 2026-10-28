import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import { type CommandRunner, issuePairingLink, readSshConfigAliases, runCommand } from "./ssh-pairing.js";
import { ORCHESTRATION_PROTOCOL_VERSION, record, textValue } from "./t3-protocol.js";

const T3_PORT = 3773;
const MAX_PEERS = 64;
const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
// Long enough for a first request that has to set up a relayed Tailscale connection.
const PROBE_TIMEOUT_MS = 5_000;
const MAX_SSH_ALIASES = 64;
const SSH_TARGETS_TTL_MS = 10_000;

// Tailscale hands out addresses only from these ranges, and traffic to them is WireGuard-encrypted.
const TAILNET = new BlockList();
TAILNET.addSubnet("100.64.0.0", 10, "ipv4"); // NOSONAR: Tailscale's fixed address range
TAILNET.addSubnet("fd7a:115c:a1e0::", 48, "ipv6"); // NOSONAR: Tailscale's fixed address range

export type DescriptorProbe = (origin: string) => Promise<boolean>;

/** An online tailnet device: its MagicDNS names and every address it is reachable at. */
export interface TailnetPeer {
	name: string;
	dnsName: string;
	addresses: string[];
}
export type AddressLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/**
 * Lists the online tailnet devices that answer as a T3 server on the default port, by their
 * MagicDNS short name.
 */
export async function discoverTailnetHosts(
	run: CommandRunner = statusRunner,
	probe: DescriptorProbe = probeT3Server,
): Promise<string[]> {
	const peers = (await tailnetPeers(run)).slice(0, MAX_PEERS);
	const answers = await Promise.all(
		peers.map((peer) => probe(`http://${peer.dnsName}:${T3_PORT}`).catch(() => false)),
	);
	return peers.filter((_, index) => answers[index]).map((peer) => peer.name);
}

export async function tailnetPeers(run: CommandRunner = statusRunner): Promise<TailnetPeer[]> {
	const result = await run("tailscale", ["status", "--json"]);
	if (result.code !== 0) return [];
	let status: unknown;
	try {
		status = JSON.parse(result.stdout);
	} catch {
		return [];
	}
	if (!record(status) || !record(status.Peer)) return [];
	const peers: TailnetPeer[] = [];
	for (const peer of Object.values(status.Peer)) {
		if (!record(peer) || peer.Online !== true || !textValue(peer.DNSName, 253)) continue;
		const dnsName = peer.DNSName.replace(/\.$/, "");
		if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(dnsName)) continue;
		const ips = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.filter((ip) => textValue(ip, 64)) : [];
		// CurAddr is the direct endpoint, such as 192.168.1.59:41641, when the peer is on the same LAN.
		const direct = textValue(peer.CurAddr, 80) ? /^\[?(.*?)\]?:\d+$/.exec(peer.CurAddr)?.[1] : undefined;
		peers.push({
			name: dnsName.split(".")[0] ?? dnsName,
			dnsName,
			addresses: [...ips, ...(direct ? [direct] : [])],
		});
	}
	return peers;
}

/**
 * The SSH config alias for a tailnet host that has none of its own: the alias whose host name is one of
 * the device's addresses or names. For example, `mac-mini` on the tailnet is `macmini` at 192.168.1.56
 * in the SSH config. Returns undefined when SSH should use the name as it is.
 */
export function matchSshTarget(
	hostname: string,
	aliases: ReadonlyMap<string, string>,
	peers: readonly TailnetPeer[],
): string | undefined {
	if (aliases.has(hostname)) return undefined;
	const peer = peers.find((candidate) => candidate.name === hostname || candidate.dnsName === hostname);
	if (!peer) return undefined;
	const names = new Set([peer.name, peer.dnsName, ...peer.addresses]);
	for (const [alias, target] of aliases) if (names.has(target)) return alias;
	return undefined;
}

/**
 * Issues pairing links over SSH, reaching tailnet devices through their SSH config alias when their
 * tailnet name has none. The alias table is read once per batch of hosts.
 */
export function sshPairingIssuer(
	run: CommandRunner = statusRunner,
	now: () => number = Date.now,
	readAliases: () => Promise<string[]> = () => readSshConfigAliases(),
): (host: string) => Promise<string> {
	let cached: { at: number; table: Promise<[Map<string, string>, TailnetPeer[]]> } | undefined;
	return async (host) => {
		if (!cached || now() - cached.at > SSH_TARGETS_TTL_MS)
			cached = { at: now(), table: Promise.all([sshAliasTargets(run, readAliases), tailnetPeers(run)]) };
		const [aliases, peers] = await cached.table;
		return issuePairingLink(host, matchSshTarget(host.split(":")[0] ?? host, aliases, peers), run);
	};
}

/** Each SSH config alias with the host name SSH resolves it to. */
async function sshAliasTargets(
	run: CommandRunner,
	readAliases: () => Promise<string[]>,
): Promise<Map<string, string>> {
	const aliases = (await readAliases()).slice(0, MAX_SSH_ALIASES);
	const resolved = await Promise.all(aliases.map((alias) => run("ssh", ["-G", "--", alias])));
	const targets = new Map<string, string>();
	for (const [index, alias] of aliases.entries()) {
		const target = /^hostname (\S+)$/m.exec(resolved[index]?.stdout ?? "")?.[1];
		if (target) targets.set(alias, target);
	}
	return targets;
}

function statusRunner(command: string, args: string[]) {
	return runCommand(command, args, MAX_STATUS_BYTES);
}

/** The Tailscale address of `hostname` (IPv4 first) when every address it resolves to is one, else undefined. */
export async function tailnetAddress(
	hostname: string,
	resolve: AddressLookup = (name) => lookup(name, { all: true }),
): Promise<string | undefined> {
	try {
		const addresses = await resolve(hostname);
		if (!addresses.every(({ address, family }) => TAILNET.check(address, family === 6 ? "ipv6" : "ipv4")))
			return undefined;
		return (addresses.find(({ family }) => family === 4) ?? addresses[0])?.address;
	} catch {
		return undefined;
	}
}

async function probeT3Server(origin: string): Promise<boolean> {
	const response = await fetch(`${origin}/.well-known/t3/environment`, {
		redirect: "error",
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
	if (!response.ok || !response.body) return false;
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const chunk of response.body) {
		bytes += chunk.length;
		if (bytes > MAX_DESCRIPTOR_BYTES) return false;
		chunks.push(chunk);
	}
	const descriptor: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	return (
		record(descriptor) &&
		textValue(descriptor.environmentId) &&
		descriptor.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION
	);
}
