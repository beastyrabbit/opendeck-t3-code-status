import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { cp, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ACTION_UUID, PLUGIN_UUID } from "../src/types.js";
import { PLUGIN_DIRECTORY } from "./profile.js";

const REQUIRED_PLUGIN_FILES = [
	"THIRD_PARTY_NOTICES.md",
	"manifest.json",
	"bin/plugin.cjs",
	"icons/action.svg",
	"property-inspector/index.html",
	"property-inspector/property-inspector.js",
	"property-inspector/styles.css",
];

interface InstallPluginDependencies {
	rename: typeof rename;
}

export interface InstallPluginOptions {
	afterInstall?: () => Promise<void>;
	afterRollback?: (restoredPrevious: boolean) => Promise<void>;
}

const defaultInstallPluginDependencies: InstallPluginDependencies = { rename };

export async function validatePluginSource(source: string): Promise<void> {
	for (const path of REQUIRED_PLUGIN_FILES) {
		let metadata: Stats;
		try {
			metadata = await stat(resolve(source, path));
		} catch {
			throw new Error(`Built plugin is incomplete. Missing ${path}.`);
		}
		if (!metadata.isFile()) throw new Error(`Built plugin is incomplete. ${path} is not a file.`);
	}

	let manifest: unknown;
	try {
		manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8"));
	} catch {
		throw new Error("Built plugin manifest is not valid JSON.");
	}
	const actions = isRecord(manifest) && Array.isArray(manifest.Actions) ? manifest.Actions : [];
	if (
		!isRecord(manifest) ||
		manifest.UUID !== PLUGIN_UUID ||
		!actions.some((action) => isRecord(action) && action.UUID === ACTION_UUID)
	) {
		throw new Error("Built plugin manifest does not describe the T3 Code Status action.");
	}
}

/** Stages a complete copy before replacing the installed directory. */
export async function installPlugin(
	source: string,
	target: string,
	options: InstallPluginOptions = {},
	dependencies: InstallPluginDependencies = defaultInstallPluginDependencies,
): Promise<void> {
	if (resolve(source) === resolve(target)) return;
	const pluginsDirectory = dirname(target);
	await mkdir(pluginsDirectory, { recursive: true });
	await assertRealDirectory(pluginsDirectory);
	const identifier = `${process.pid}.${randomUUID()}`;
	const staged = resolve(pluginsDirectory, `.${PLUGIN_DIRECTORY}.${identifier}.new`);
	const previous = resolve(pluginsDirectory, `.${PLUGIN_DIRECTORY}.${identifier}.old`);
	let installationCommitted = false;
	let previousMoved = false;
	try {
		await cp(source, staged, { errorOnExist: true, force: false, recursive: true });
		await assertRealDirectory(pluginsDirectory);
		if (await fileExists(target)) {
			await dependencies.rename(target, previous);
			previousMoved = true;
			try {
				await dependencies.rename(staged, target);
			} catch (error) {
				try {
					await dependencies.rename(previous, target);
					previousMoved = false;
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Could not replace the installed plugin or restore it. The previous installation remains at ${previous}.`,
					);
				}
				throw new Error("Could not replace the installed plugin. The previous installation was restored.", {
					cause: error,
				});
			}
		} else {
			await dependencies.rename(staged, target);
		}
		try {
			await options.afterInstall?.();
		} catch (error) {
			const hadPrevious = previousMoved;
			try {
				await dependencies.rename(target, staged);
				if (previousMoved) {
					await dependencies.rename(previous, target);
					previousMoved = false;
				}
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					`The installed plugin failed activation and could not be rolled back. The previous installation remains at ${previous}.`,
				);
			}
			try {
				await options.afterRollback?.(hadPrevious);
			} catch (rollbackActivationError) {
				throw new AggregateError(
					[error, rollbackActivationError],
					hadPrevious
						? "The installed plugin failed activation. The previous installation files were restored, but OpenDeck could not reactivate them. Restart OpenDeck once."
						: "The installed plugin failed activation and was removed, but OpenDeck could not confirm that its process stopped. Restart OpenDeck once.",
				);
			}
			throw new Error(
				hadPrevious
					? "The installed plugin failed activation. The previous installation was restored."
					: "The installed plugin failed activation and was removed.",
				{ cause: error },
			);
		}
		installationCommitted = true;
	} finally {
		await rm(staged, { force: true, recursive: true });
		if (installationCommitted && previousMoved) {
			await rm(previous, { force: true, recursive: true });
		}
	}
}

async function assertRealDirectory(path: string): Promise<void> {
	let metadata: Stats;
	try {
		metadata = await lstat(path);
	} catch (error) {
		throw new Error(`Plugin destination is unavailable: ${path}`, { cause: error });
	}
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new Error(`Plugin destination must be a real directory: ${path}`);
	}
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
