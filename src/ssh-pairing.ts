import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { LiveConnectionError, record, textValue } from "./t3-protocol.js";

const T3_PORT = 3773;
const MAX_HOSTS = 16;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
// A host name with an optional port. It cannot start with "-", so ssh never reads it as an option.
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?$/;
// Fixed, so nothing typed in the settings ever reaches the remote shell. A managed T3 runtime
// records its active version; its own CLI always matches the running server, while another t3 on
// the PATH may be older and hang. Non-interactive SSH shells often lack the user's PATH, so the
// fallback also looks where the t3 installers put the command.
const REMOTE_COMMAND = [
	String.raw`v=$(sed -n 's/.*"activeVersion": *"\([^"]*\)".*/\1/p' "$HOME/.t3/runtime/service-state.json" 2>/dev/null)`,
	't3="$HOME/.t3/runtime/versions/$v/t3"',
	'{ [ -n "$v" ] && [ -x "$t3" ]; } || t3=t3',
	'PATH="$PATH:$HOME/.local/bin:$HOME/.t3/bin" "$t3" auth pairing create --scope orchestration:read --ttl 5m --label opendeck-t3-code-status --json',
].join("; ");
// Windows T3 Code ships no t3 command; its app runs the same CLI in Node mode. Runs in cmd, the
// default shell of Windows OpenSSH, and is tried only when the command above fails.
const WINDOWS_COMMAND = String.raw`set ELECTRON_RUN_AS_NODE=1&& "%LOCALAPPDATA%\Programs\t3code\T3 Code (Beta).exe" "%LOCALAPPDATA%\Programs\t3code\resources\server.asar\apps\server\dist\bin.mjs" auth pairing create --scope orchestration:read --ttl 5m --label opendeck-t3-code-status --json`;
const MAX_CONFIG_BYTES = 256 * 1024;

export interface CommandResult {
	code: number | null;
	stdout: string;
}
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

/** Splits a list like "anvil, kiln devbox:3774" into unique host entries. */
export function parseSshHosts(value: string): string[] {
	const hosts = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
	if (hosts.length === 0 || hosts.length > MAX_HOSTS || !hosts.every((host) => HOST_PATTERN.test(host)))
		throw new LiveConnectionError("invalid-host");
	return hosts;
}

/**
 * Creates a short-lived read-only pairing token over SSH and returns it as a pairing link for the T3
 * server at `host`. `sshTarget` names the same machine in the SSH config when it differs from `host`.
 * The token stays in memory; it is never logged or shown.
 */
export async function issuePairingLink(
	host: string,
	sshTarget?: string,
	run: CommandRunner = runCommand,
): Promise<string> {
	const [hostname = "", port = String(T3_PORT)] = host.split(":");
	const ssh = (command: string) =>
		run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", sshTarget ?? hostname, command]);
	let result = await ssh(REMOTE_COMMAND);
	if (result.code === 255) throw new LiveConnectionError("ssh-failed");
	let credential = issuedCredential(result);
	if (credential === undefined) {
		const windows = await ssh(WINDOWS_COMMAND);
		credential = issuedCredential(windows);
		if (credential === undefined) result = windows.code === 0 ? windows : result;
	}
	if (credential === undefined)
		throw new LiveConnectionError(result.code === 127 ? "t3-missing" : "t3-failed");
	const link = new URL(`http://${hostname}:${port}/pair`);
	link.hash = new URLSearchParams({ token: credential }).toString();
	return link.toString();
}

function issuedCredential(result: CommandResult): string | undefined {
	if (result.code !== 0) return undefined;
	try {
		const issued: unknown = JSON.parse(result.stdout);
		return record(issued) && textValue(issued.credential, 8192) ? issued.credential : undefined;
	} catch {
		return undefined;
	}
}

/** Splits an ssh_config line into its lower-case keyword and value; both forms `Key value` and `Key=value` occur. */
function sshDirective(line: string): [keyword: string, value: string] {
	const trimmed = line.trim();
	const keyEnd = trimmed.search(/[\s=]/);
	if (keyEnd <= 0) return ["", ""];
	let value = trimmed.slice(keyEnd).trim();
	if (value.startsWith("=")) value = value.slice(1).trim();
	return [trimmed.slice(0, keyEnd).toLowerCase(), value];
}

/** The literal `Host` names in the user's SSH config and the files it includes. */
export async function readSshConfigAliases(
	path = join(homedir(), ".ssh", "config"),
	depth = 0,
): Promise<string[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	if (text.length > MAX_CONFIG_BYTES) return [];
	const aliases: string[] = [];
	for (const line of text.split("\n")) {
		const [keyword, value] = sshDirective(line);
		if (!value || (keyword !== "host" && keyword !== "include")) continue;
		const values = value.split(/\s+/);
		if (keyword === "host") {
			aliases.push(...values.filter((value) => HOST_PATTERN.test(value)));
		} else if (depth < 4) {
			aliases.push(...(await readIncludedAliases(values, depth + 1)));
		}
	}
	return [...new Set(aliases)];
}

/** Aliases from the literal files an `Include` names; glob patterns are skipped. */
async function readIncludedAliases(files: string[], depth: number): Promise<string[]> {
	const aliases: string[] = [];
	for (const value of files.filter((file) => !/[*?[]/.test(file))) {
		const file = value.replace(/^~(?=\/)/, homedir());
		aliases.push(
			...(await readSshConfigAliases(isAbsolute(file) ? file : join(homedir(), ".ssh", file), depth)),
		);
	}
	return aliases;
}

/** Runs a command without a shell and collects its output, up to `maxBytes`. */
export function runCommand(
	command: string,
	args: string[],
	maxBytes = MAX_OUTPUT_BYTES,
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], timeout: COMMAND_TIMEOUT_MS });
		const chunks: Buffer[] = [];
		let bytes = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) child.kill();
			else chunks.push(chunk);
		});
		child.on("error", () => resolve({ code: 255, stdout: "" }));
		child.on("close", (code) =>
			resolve({
				code: bytes > maxBytes ? null : code,
				stdout: Buffer.concat(chunks).toString("utf8"),
			}),
		);
	});
}
