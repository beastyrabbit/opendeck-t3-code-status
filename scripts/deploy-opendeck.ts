import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	fileExists,
	type InstallPluginOptions,
	installPlugin,
	validatePluginSource,
} from "./plugin-install.js";
import { PLUGIN_DIRECTORY } from "./profile.js";
import { defaultOpenDeckConfigRoot } from "./setup-opendeck.js";

const run = promisify(execFile);
const RELOAD_TIMEOUT_MS = 5_000;

interface OpenDeckProcess {
	executable: string;
	pid: number;
}

export interface DeployOptions {
	configRoot: string;
	dryRun: boolean;
	pluginSource: string;
}

interface DeployDependencies {
	findOpenDeckProcesses: () => Promise<OpenDeckProcess[]>;
	findRegisteredPluginPids: (openDeckPid: number) => Promise<number[]>;
	install: (source: string, target: string, options: InstallPluginOptions) => Promise<void>;
	platform: NodeJS.Platform;
	reload: (executable: string) => Promise<void>;
	validate: typeof validatePluginSource;
	waitForReload: (openDeckPid: number, previousPids: ReadonlySet<number>) => Promise<number>;
	waitForStop: (openDeckPid: number) => Promise<void>;
}

export interface DeployResult {
	installedBefore: boolean;
	mode: "dry-run" | "hot-reloaded" | "installed-stopped";
	openDeckPid?: number;
	pluginPid?: number;
}

const defaultDependencies: DeployDependencies = {
	findOpenDeckProcesses,
	findRegisteredPluginPids,
	install: installPlugin,
	platform: platform(),
	reload: reloadOpenDeckPlugin,
	validate: validatePluginSource,
	waitForReload,
	waitForStop,
};

export async function deployOpenDeck(
	options: DeployOptions,
	dependencies: DeployDependencies = defaultDependencies,
): Promise<DeployResult> {
	if (dependencies.platform !== "linux") {
		throw new Error("OpenDeck hot deployment is currently supported on Linux only.");
	}
	await dependencies.validate(options.pluginSource);
	const pluginTarget = resolve(options.configRoot, "plugins", PLUGIN_DIRECTORY);
	const installedBefore = await fileExists(pluginTarget);
	const running = await dependencies.findOpenDeckProcesses();
	if (running.length > 1) {
		throw new Error(`Found ${running.length} OpenDeck processes. Stop the extra instances first.`);
	}
	const current = running[0];

	if (options.dryRun) {
		return {
			installedBefore,
			mode: "dry-run",
			...(current ? { openDeckPid: current.pid } : {}),
		};
	}

	const previousPluginPids = current
		? new Set(await dependencies.findRegisteredPluginPids(current.pid))
		: new Set<number>();
	const activation: { pluginPid?: number } = {};
	await dependencies.install(options.pluginSource, pluginTarget, {
		afterInstall: async () => {
			if (!current) return;
			const stillRunning = (await dependencies.findOpenDeckProcesses()).some(
				(candidate) => candidate.pid === current.pid && candidate.executable === current.executable,
			);
			if (!stillRunning) return;
			await dependencies.reload(current.executable);
			activation.pluginPid = await dependencies.waitForReload(current.pid, previousPluginPids);
		},
		afterRollback: async (restoredPrevious) => {
			if (!current) return;
			const stillRunning = (await dependencies.findOpenDeckProcesses()).some(
				(candidate) => candidate.pid === current.pid && candidate.executable === current.executable,
			);
			if (!stillRunning) return;
			const rollbackPids = new Set(await dependencies.findRegisteredPluginPids(current.pid));
			await dependencies.reload(current.executable);
			if (restoredPrevious) {
				await dependencies.waitForReload(current.pid, rollbackPids);
			} else {
				await dependencies.waitForStop(current.pid);
			}
		},
	});
	if (current && activation.pluginPid !== undefined) {
		return {
			installedBefore,
			mode: "hot-reloaded",
			openDeckPid: current.pid,
			pluginPid: activation.pluginPid,
		};
	}
	return {
		installedBefore,
		mode: "installed-stopped",
	};
}

export function parseDeployArguments(
	args: readonly string[],
	environment: NodeJS.ProcessEnv = process.env,
	userHome = homedir(),
): DeployOptions {
	let configRoot = defaultOpenDeckConfigRoot(platform(), environment, userHome);
	let pluginSource = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", PLUGIN_DIRECTORY);
	let dryRun = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") continue;
		if (argument === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (argument !== "--config" && argument !== "--plugin-source") {
			throw new Error(`Unknown deploy option: ${argument ?? ""}`);
		}
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
		index += 1;
		if (argument === "--config") configRoot = resolve(value);
		else pluginSource = resolve(value);
	}
	return { configRoot, dryRun, pluginSource };
}

export async function findOpenDeckProcesses(): Promise<OpenDeckProcess[]> {
	const processes: OpenDeckProcess[] = [];
	for (const entry of await readdir("/proc", { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		try {
			const processRoot = resolve("/proc", entry.name);
			if ((await readFile(resolve(processRoot, "comm"), "utf8")).trim() !== "opendeck") continue;
			processes.push({
				executable: await readlink(resolve(processRoot, "exe")),
				pid: Number(entry.name),
			});
		} catch {
			// The process may end while /proc is being read.
		}
	}
	return processes;
}

export async function findRegisteredPluginPids(openDeckPid: number): Promise<number[]> {
	const pids: number[] = [];
	for (const entry of await readdir("/proc", { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		try {
			const processRoot = resolve("/proc", entry.name);
			const status = await readFile(resolve(processRoot, "status"), "utf8");
			const parentPid = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
			if (parentPid !== openDeckPid) continue;
			const commandLine = (await readFile(resolve(processRoot, "cmdline"), "utf8"))
				.split("\0")
				.filter(Boolean);
			const uuidIndex = commandLine.indexOf("-pluginUUID");
			if (uuidIndex >= 0 && commandLine[uuidIndex + 1] === PLUGIN_DIRECTORY) {
				pids.push(Number(entry.name));
			}
		} catch {
			// The child may exit while /proc is being read.
		}
	}
	return pids;
}

async function reloadOpenDeckPlugin(executable: string): Promise<void> {
	try {
		await run(executable, ["--reload-plugin", PLUGIN_DIRECTORY], {
			timeout: RELOAD_TIMEOUT_MS,
			windowsHide: true,
		});
	} catch {
		throw new Error("OpenDeck did not accept the plugin reload command.");
	}
}

async function waitForReload(openDeckPid: number, previousPids: ReadonlySet<number>): Promise<number> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const currentPids = await findRegisteredPluginPids(openDeckPid);
		const replacement = currentPids.find((pid) => !previousPids.has(pid));
		if (replacement !== undefined && currentPids.length === 1) return replacement;
		await delay(100);
	}
	throw new Error(
		"Plugin files were installed, but the OpenDeck hot reload could not be confirmed. Restart OpenDeck once.",
	);
}

async function waitForStop(openDeckPid: number): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if ((await findRegisteredPluginPids(openDeckPid)).length === 0) return;
		await delay(100);
	}
	throw new Error("The failed plugin process could not be confirmed stopped. Restart OpenDeck once.");
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function report(result: DeployResult): void {
	const operation = result.installedBefore ? "update" : "install";
	if (result.mode === "dry-run") {
		console.log(`Would ${operation} ${PLUGIN_DIRECTORY}.`);
		console.log(
			result.openDeckPid
				? `Would hot-reload it in OpenDeck process ${result.openDeckPid}.`
				: "OpenDeck is stopped; it would load the plugin on its next start.",
		);
		return;
	}
	console.log(`Plugin ${operation}d: ${PLUGIN_DIRECTORY}`);
	if (result.mode === "hot-reloaded") {
		console.log(`OpenDeck stayed open; plugin process ${result.pluginPid} is running the new build.`);
	} else {
		console.log("OpenDeck is stopped and will load the new build on its next start.");
	}
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
	const result = await deployOpenDeck(parseDeployArguments(process.argv.slice(2)));
	report(result);
}
