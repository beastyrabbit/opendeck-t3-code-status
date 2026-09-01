import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
	chmod,
	cp,
	lstat,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fileExists, installPlugin, validatePluginSource } from "./plugin-install.js";
import {
	assertOpenDeckProfileStructure,
	PLUGIN_DIRECTORY,
	parseOpenDeckProfile,
	placeOverview,
} from "./profile.js";

export interface SetupOptions {
	configRoot?: string;
	device?: string;
	dryRun: boolean;
	pluginSource?: string;
	profile?: string;
}

export interface SetupDependencies {
	isOpenDeckRunning: () => Promise<boolean>;
}

export interface SetupResult {
	alreadyPresent: boolean;
	device: string;
	dryRun: boolean;
	installedBefore: boolean;
	position: number;
	profile: string;
}

const defaultDependencies: SetupDependencies = { isOpenDeckRunning };
export const MAX_OPENDECK_PROFILE_BYTES = 4 * 1024 * 1024;
export const MAX_OPENDECK_SELECTOR_BYTES = 16 * 1024;
const MAX_OPENDECK_SELECTOR_PROPERTIES = 16;
const MAX_OPENDECK_SELECTOR_STRING_CODE_UNITS = 255;

export async function setupOpenDeck(
	options: SetupOptions,
	dependencies: SetupDependencies = defaultDependencies,
): Promise<SetupResult> {
	const requestedConfigRoot = options.configRoot ?? defaultOpenDeckConfigRoot();
	const configRoot = await realpath(requestedConfigRoot);
	const profilesRoot = resolve(configRoot, "profiles");
	await assertRealDirectory(profilesRoot, "OpenDeck profiles directory");
	const device = validateFileName("device", options.device ?? (await discoverDevice(profilesRoot)));
	const deviceRoot = resolve(profilesRoot, device);
	await assertRealDirectory(deviceRoot, "OpenDeck device directory");
	const profileName = validateFileName(
		"profile",
		options.profile ?? (await discoverDefaultProfile(profilesRoot, device)),
	);
	const profilePath = resolve(deviceRoot, `${profileName}.json`);
	await assertRealFile(profilePath, "OpenDeck profile");
	const pluginSource = await locatePluginSource(options.pluginSource);
	await validatePluginSource(pluginSource);

	const initialRawProfile = await readBoundedTextFile(
		profilePath,
		MAX_OPENDECK_PROFILE_BYTES,
		"OpenDeck profile",
	);
	const initialProfile = parseOpenDeckProfile(initialRawProfile, profilePath);
	const initialPlacement = placeOverview(initialProfile);
	if (!initialPlacement.alreadyPresent) prepareProfileWrite(initialProfile, profilePath);
	const pluginPath = resolve(configRoot, "plugins", PLUGIN_DIRECTORY);
	const installedBefore = await fileExists(resolve(pluginPath, "manifest.json"));

	if (options.dryRun) {
		return {
			alreadyPresent: initialPlacement.alreadyPresent,
			device,
			dryRun: true,
			installedBefore,
			position: initialPlacement.position,
			profile: profileName,
		};
	}

	if (await dependencies.isOpenDeckRunning()) {
		throw new Error(
			"OpenDeck is running. Quit it before setup so it cannot overwrite the plugin or profile files.",
		);
	}

	const currentRawProfile = await readBoundedTextFile(
		profilePath,
		MAX_OPENDECK_PROFILE_BYTES,
		"OpenDeck profile",
	);
	const currentProfile = parseOpenDeckProfile(currentRawProfile, profilePath);
	const placement = placeOverview(currentProfile);
	const updatedRawProfile = placement.alreadyPresent
		? undefined
		: prepareProfileWrite(currentProfile, profilePath);
	await installPlugin(pluginSource, pluginPath);
	if (updatedRawProfile !== undefined) {
		if (await dependencies.isOpenDeckRunning()) {
			throw new Error(
				"OpenDeck started during setup. The plugin was copied, but the profile was not changed.",
			);
		}
		if (
			(await readBoundedTextFile(profilePath, MAX_OPENDECK_PROFILE_BYTES, "OpenDeck profile")) !==
			currentRawProfile
		) {
			throw new Error(
				"The OpenDeck profile changed during setup. The plugin was installed, but the profile was not changed.",
			);
		}
		await assertRealDirectory(deviceRoot, "OpenDeck device directory");
		const profileMode = (await assertRealFile(profilePath, "OpenDeck profile")).mode & 0o777;
		await backup(profilePath);
		await atomicWrite(profilePath, updatedRawProfile, profileMode);
	}

	return {
		alreadyPresent: placement.alreadyPresent,
		device,
		dryRun: false,
		installedBefore,
		position: placement.position,
		profile: profileName,
	};
}

function prepareProfileWrite(profile: unknown, path: string): string {
	assertOpenDeckProfileStructure(profile, path);
	const contents = `${JSON.stringify(profile, null, 2)}\n`;
	if (Buffer.byteLength(contents) > MAX_OPENDECK_PROFILE_BYTES) {
		throw new FileSizeLimitError(
			`Updated OpenDeck profile would exceed the ${formatByteLimit(MAX_OPENDECK_PROFILE_BYTES)}: ${path}`,
		);
	}
	return contents;
}

async function assertRealDirectory(path: string, label: string): Promise<Stats> {
	return assertRealPath(path, label, "directory");
}

async function assertRealFile(path: string, label: string): Promise<Stats> {
	return assertRealPath(path, label, "file");
}

async function assertRealPath(path: string, label: string, kind: "directory" | "file"): Promise<Stats> {
	let metadata: Stats;
	try {
		metadata = await lstat(path);
	} catch (error) {
		throw new Error(`${label} is unavailable: ${path}`, { cause: error });
	}
	const matchesKind = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
	if (metadata.isSymbolicLink() || !matchesKind) throw new Error(`${label} must be a real ${kind}: ${path}`);
	return metadata;
}

export function defaultOpenDeckConfigRoot(
	currentPlatform = platform(),
	environment: NodeJS.ProcessEnv = process.env,
	userHome = homedir(),
): string {
	if (currentPlatform === "linux") {
		const xdgConfigHome = environment.XDG_CONFIG_HOME;
		const configHome =
			xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : resolve(userHome, ".config");
		return resolve(configHome, "opendeck");
	}
	return resolve(userHome, ".config", "opendeck");
}

export function parseSetupArguments(args: readonly string[]): SetupOptions {
	const result: SetupOptions = { dryRun: false };
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") continue;
		if (argument === "--dry-run") {
			result.dryRun = true;
			continue;
		}
		if (!["--config", "--device", "--plugin-source", "--profile"].includes(argument ?? "")) {
			throw new Error(`Unknown setup option: ${argument ?? ""}`);
		}
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
		index += 1;
		switch (argument) {
			case "--config":
				result.configRoot = resolve(value);
				break;
			case "--device":
				result.device = value;
				break;
			case "--plugin-source":
				result.pluginSource = resolve(value);
				break;
			case "--profile":
				result.profile = value;
				break;
		}
	}
	return result;
}

async function discoverDevice(profilesRoot: string): Promise<string> {
	let entries: Dirent[];
	try {
		entries = await readdir(profilesRoot, { withFileTypes: true });
	} catch {
		throw new Error(`OpenDeck profiles not found: ${profilesRoot}`);
	}
	const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	if (candidates.length !== 1) {
		throw new Error(`Expected one OpenDeck device, found ${candidates.length}. Pass --device <id>.`);
	}
	return candidates[0] as string;
}

async function discoverDefaultProfile(profilesRoot: string, device: string): Promise<string> {
	if (await fileExists(resolve(profilesRoot, device, "Default.json"))) return "Default";

	const selectorPath = resolve(profilesRoot, `${device}.json`);
	try {
		const rawSelector = await readBoundedTextFile(
			selectorPath,
			MAX_OPENDECK_SELECTOR_BYTES,
			"OpenDeck profile selector",
		);
		const selectedProfile = parseSelectedProfile(rawSelector);
		if (selectedProfile !== undefined) return selectedProfile;
	} catch (error) {
		if (error instanceof FileSizeLimitError) throw error;
		// Fall back only when the device has a single profile file.
	}

	const deviceDirectory = resolve(profilesRoot, device);
	const candidates = (await readdir(deviceDirectory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && extname(entry.name) === ".json")
		.map((entry) => entry.name.slice(0, -5));
	if (candidates.length === 1) return candidates[0] as string;
	throw new Error(`Could not determine the selected profile for ${device}. Pass --profile <name>.`);
}

function parseSelectedProfile(raw: string): string | undefined {
	let selector: unknown;
	try {
		selector = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(selector)) return undefined;
	const properties = Object.keys(selector);
	if (
		properties.length > MAX_OPENDECK_SELECTOR_PROPERTIES ||
		properties.some((property) => !isSelectorScalar(selector[property]))
	) {
		return undefined;
	}
	const selectedProfile = selector.selected_profile;
	return typeof selectedProfile === "string" &&
		selectedProfile.length > 0 &&
		selectedProfile.length <= MAX_OPENDECK_SELECTOR_STRING_CODE_UNITS
		? selectedProfile
		: undefined;
}

function isSelectorScalar(value: unknown): boolean {
	return (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

class FileSizeLimitError extends Error {}

async function readBoundedTextFile(path: string, maxBytes: number, label: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const metadata = await handle.stat({ bigint: true });
		if (!metadata.isFile()) throw new Error(`${label} must be a real file: ${path}`);
		if (metadata.size > BigInt(maxBytes)) {
			throw new FileSizeLimitError(`${label} exceeds the ${formatByteLimit(maxBytes)}: ${path}`);
		}

		const size = Number(metadata.size);
		const contents = Buffer.allocUnsafe(size);
		let offset = 0;
		while (offset < size) {
			const { bytesRead } = await handle.read(contents, offset, size - offset, offset);
			if (bytesRead === 0) throw new Error(`${label} changed while setup was reading it: ${path}`);
			offset += bytesRead;
		}
		const extra = Buffer.allocUnsafe(1);
		if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
			throw new FileSizeLimitError(`${label} exceeds the ${formatByteLimit(maxBytes)}: ${path}`);
		}
		return contents.toString("utf8");
	} finally {
		await handle.close();
	}
}

function formatByteLimit(bytes: number): string {
	if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB size limit`;
	if (bytes % 1024 === 0) return `${bytes / 1024} KiB size limit`;
	return `${bytes}-byte size limit`;
}

async function locatePluginSource(explicitSource: string | undefined): Promise<string> {
	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		explicitSource,
		resolve(scriptDirectory, PLUGIN_DIRECTORY),
		resolve(scriptDirectory, "..", "dist", PLUGIN_DIRECTORY),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		if (await fileExists(resolve(candidate, "manifest.json"))) return candidate;
	}
	throw new Error("Built plugin not found. Run pnpm build first or pass --plugin-source <path>.");
}

async function isOpenDeckRunning(): Promise<boolean> {
	if (platform() !== "linux") return false;
	for (const entry of await readdir("/proc", { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		try {
			if ((await readFile(resolve("/proc", entry.name, "comm"), "utf8")).trim() === "opendeck") return true;
		} catch {
			// The process may have ended while /proc was being read.
		}
	}
	return false;
}

async function backup(path: string): Promise<void> {
	await assertRealFile(path, "OpenDeck profile");
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	await cp(path, `${path}.backup-${timestamp}`, { errorOnExist: true, force: false });
}

async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
	await assertRealDirectory(dirname(path), "OpenDeck profile directory");
	await assertRealFile(path, "OpenDeck profile");
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, contents, { flag: "wx", mode });
		await rename(temporaryPath, path);
		if (platform() !== "win32") await chmod(path, mode);
	} finally {
		try {
			await unlink(temporaryPath);
		} catch {
			// Rename removes the temporary path; failed writes may leave nothing to clean up.
		}
	}
}

function validateFileName(label: string, value: string): string {
	if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
		throw new Error(`Invalid OpenDeck ${label}: ${value}`);
	}
	return value;
}

function report(result: SetupResult): void {
	console.log(`${result.dryRun ? "Would configure" : "Configured"} OpenDeck device ${result.device}:`);
	console.log(`- plugin: ${result.installedBefore ? "updated" : "installed"}`);
	console.log(`- profile: ${result.profile}`);
	console.log(
		`- overview: key ${result.position + 1}${result.alreadyPresent ? " (already present)" : " (added)"}`,
	);
	if (!result.dryRun) console.log("Start OpenDeck again so it loads the plugin and profile change.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
	const result = await setupOpenDeck(parseSetupArguments(process.argv.slice(2)));
	report(result);
}
