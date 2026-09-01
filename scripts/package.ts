import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readdir, readFile, rm, utimes } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_UUID } from "../src/types.js";
import { PLUGIN_DIRECTORY } from "./profile.js";
import { verifyRelease } from "./verify-release.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(projectRoot, "dist");
const releaseRoot = resolve(projectRoot, "release");
const setupName = `${PLUGIN_UUID}-opendeck-setup`;
const setupRoot = resolve(releaseRoot, setupName);
const setupArchive = resolve(releaseRoot, `${setupName}.tar.gz`);
const pluginArchive = resolve(releaseRoot, `${PLUGIN_UUID}.streamDeckPlugin`);
const normalizedTimestamp = new Date("2000-01-01T00:00:00.000Z");

async function build(): Promise<void> {
	execFileSync("pnpm", ["build"], { cwd: projectRoot, stdio: "inherit" });
}

async function createRelease(validateWithElgato: boolean): Promise<void> {
	await rm(releaseRoot, { force: true, recursive: true });
	await mkdir(releaseRoot, { recursive: true });
	if (validateWithElgato) {
		execFileSync(
			"pnpm",
			[
				"exec",
				"streamdeck",
				"pack",
				"--force",
				"--ignore-validation",
				"--no-update-check",
				"--no-file-list",
				"--output",
				releaseRoot,
				resolve(distRoot, PLUGIN_DIRECTORY),
			],
			{ cwd: projectRoot, stdio: "inherit" },
		);
	}
	await createDeterministicPluginArchive();
	await createDeterministicSetupArchive();
}

async function createDeterministicPluginArchive(): Promise<void> {
	const pluginRoot = resolve(distRoot, PLUGIN_DIRECTORY);
	const files = await listFiles(pluginRoot);
	for (const path of files) {
		const absolutePath = resolve(pluginRoot, path);
		await chmod(absolutePath, 0o644);
		await utimes(absolutePath, normalizedTimestamp, normalizedTimestamp);
	}
	await rm(pluginArchive, { force: true });
	execFileSync("zip", ["-X", "-q", pluginArchive, ...files.map((path) => `${PLUGIN_DIRECTORY}/${path}`)], {
		cwd: distRoot,
		env: { ...process.env, TZ: "UTC" },
		stdio: "inherit",
	});
}

async function createDeterministicSetupArchive(): Promise<void> {
	await mkdir(setupRoot, { recursive: true });
	await cp(resolve(projectRoot, "README.md"), resolve(setupRoot, "README.md"));
	await cp(resolve(distRoot, "setup-opendeck.mjs"), resolve(setupRoot, "setup-opendeck.mjs"));
	await cp(resolve(distRoot, PLUGIN_DIRECTORY), resolve(setupRoot, PLUGIN_DIRECTORY), {
		recursive: true,
	});
	execFileSync(
		"tar",
		[
			"--create",
			"--sort=name",
			`--mtime=@${Math.floor(normalizedTimestamp.getTime() / 1_000)}`,
			"--owner=0",
			"--group=0",
			"--numeric-owner",
			"--mode=u+rwX,go+rX,go-w",
			"--format=ustar",
			"--gzip",
			"--file",
			setupArchive,
			"-C",
			dirname(setupRoot),
			basename(setupRoot),
		],
		{ cwd: projectRoot, env: { ...process.env, TZ: "UTC" }, stdio: "inherit" },
	);
	await rm(setupRoot, { force: true, recursive: true });
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) files.push(relative(root, path));
			else throw new Error(`Cannot package unsupported entry: ${path}`);
		}
	}
	await visit(root);
	return files.sort();
}

await build();
await createRelease(true);
const firstPluginArchive = await readFile(pluginArchive);
const firstSetupArchive = await readFile(setupArchive);
await build();
await createRelease(false);
assert.deepEqual(await readFile(pluginArchive), firstPluginArchive, "plugin package is not reproducible");
assert.deepEqual(await readFile(setupArchive), firstSetupArchive, "setup package is not reproducible");

await verifyRelease(projectRoot);
console.log(`Reproduzierbare Release-Pakete gebaut und geprüft: ${releaseRoot}`);
