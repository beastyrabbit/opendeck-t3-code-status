import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ACTION_UUID, PLUGIN_UUID } from "../src/types.js";
import { PLUGIN_DIRECTORY } from "./profile.js";

const SETUP_NAME = `${PLUGIN_UUID}-opendeck-setup`;
const REQUIRED_PLUGIN_FILES = [
	"LICENSE",
	"THIRD_PARTY_NOTICES.md",
	"manifest.json",
	"bin/plugin.cjs",
	"icons/action.svg",
	"icons/category.svg",
	"icons/plugin.png",
	"icons/plugin.svg",
	"icons/plugin@2x.png",
	"property-inspector/index.html",
	"property-inspector/property-inspector.js",
	"property-inspector/styles.css",
];
const LEGACY_AUTH_MARKERS = [
	"credential.json",
	"local-pairing",
	"pairing-form",
	"pairing-failed",
	"pairing-route",
	"pairing-section",
	"pairingCode",
	"pairWithT3Code",
	"subject_token",
	"Create pairing link",
	"T3 Code koppeln",
	"enqueueAuthOperation",
];

interface SetupModule {
	setupOpenDeck: (
		options: { configRoot: string; dryRun: boolean },
		dependencies: { isOpenDeckRunning: () => Promise<boolean>; platform: NodeJS.Platform },
	) => Promise<{ device: string; position: number; profile: string }>;
}

export async function verifyRelease(projectRoot: string): Promise<void> {
	const distRoot = resolve(projectRoot, "dist");
	const releaseRoot = resolve(projectRoot, "release");
	const builtPlugin = resolve(distRoot, PLUGIN_DIRECTORY);
	const pluginPackage = resolve(releaseRoot, `${PLUGIN_UUID}.streamDeckPlugin`);
	const setupArchive = resolve(releaseRoot, `${SETUP_NAME}.tar.gz`);
	assert.deepEqual(
		(await readdir(releaseRoot)).sort(),
		[`${PLUGIN_UUID}.streamDeckPlugin`, `${SETUP_NAME}.tar.gz`].sort(),
		"release directory contains unexpected or missing files",
	);
	const packageJson = parseRecord(
		await readFile(resolve(projectRoot, "package.json"), "utf8"),
		"package.json",
	);
	const packageVersion = packageJson.version;
	assert.ok(typeof packageVersion === "string", "package.json has no version");
	assert.match(packageVersion, /^\d+\.\d+\.\d+$/, "package.json version must have three parts");
	const expectedManifestVersion = `${packageVersion}.0`;

	for (const path of REQUIRED_PLUGIN_FILES) await assertFile(resolve(builtPlugin, path));
	const builtPluginFiles = await listFiles(builtPlugin);
	assert.deepEqual(
		builtPluginFiles,
		[...REQUIRED_PLUGIN_FILES].sort(),
		"the built plugin contains unexpected or missing files",
	);
	await verifyManifest(resolve(builtPlugin, "manifest.json"), expectedManifestVersion);
	await verifyAuthFreeBundle(builtPlugin);

	const temporaryRoot = await mkdtemp(join(tmpdir(), "t3-code-status-release-"));
	try {
		const packageExtraction = resolve(temporaryRoot, "streamdeck-package");
		const setupExtraction = resolve(temporaryRoot, "setup-package");
		await mkdir(packageExtraction, { recursive: true });
		await mkdir(setupExtraction, { recursive: true });
		execFileSync("unzip", ["-q", pluginPackage, "-d", packageExtraction]);
		execFileSync("tar", ["-xzf", setupArchive, "-C", setupExtraction]);

		const packagedPlugin = resolve(packageExtraction, PLUGIN_DIRECTORY);
		const setupRoot = resolve(setupExtraction, SETUP_NAME);
		const setupPlugin = resolve(setupRoot, PLUGIN_DIRECTORY);
		assert.deepEqual(
			await listFiles(packageExtraction),
			builtPluginFiles.map((path) => `${PLUGIN_DIRECTORY}/${path}`),
			"the .streamDeckPlugin archive contains unexpected or missing files",
		);
		await compareTrees(builtPlugin, packagedPlugin, "the .streamDeckPlugin payload");
		await compareTrees(builtPlugin, setupPlugin, "the setup archive plugin");
		await compareFiles(
			resolve(distRoot, "setup-opendeck.mjs"),
			resolve(setupRoot, "setup-opendeck.mjs"),
			"the setup executable",
		);
		await compareFiles(
			resolve(projectRoot, "README.md"),
			resolve(setupRoot, "README.md"),
			"the setup README",
		);
		const expectedSetupFiles = [
			"README.md",
			"setup-opendeck.mjs",
			...builtPluginFiles.map((path) => `${PLUGIN_DIRECTORY}/${path}`),
		].sort();
		assert.deepEqual(
			await listFiles(setupRoot),
			expectedSetupFiles,
			"the setup archive contains unexpected or missing files",
		);
		assert.deepEqual(
			await listFiles(setupExtraction),
			expectedSetupFiles.map((path) => `${SETUP_NAME}/${path}`),
			"the setup tarball contains unexpected or missing files",
		);
		await smokeTestSetup(setupRoot, temporaryRoot);
	} finally {
		await rm(temporaryRoot, { force: true, recursive: true });
	}

	console.log(`Release ${packageVersion} geprüft: Plugin-Paket und OpenDeck-Setup sind installierbar.`);
}

async function verifyManifest(path: string, expectedVersion: string): Promise<void> {
	const manifest = parseRecord(await readFile(path, "utf8"), "manifest.json");
	assert.equal(manifest.Name, "T3 Code Status", "manifest name does not match the catalogue name");
	assert.equal(manifest.Author, "BeastyRabbit", "manifest author does not match the catalogue author");
	assert.ok(
		typeof manifest.Description === "string" && manifest.Description.trim().length > 0,
		"manifest description is empty",
	);
	assert.equal(manifest.UUID, PLUGIN_UUID, "manifest UUID does not match the release filename");
	assert.equal(
		manifest.URL,
		"https://github.com/beastyrabbit/opendeck-t3-code-status",
		"manifest URL does not point to the public source repository",
	);
	assert.equal(manifest.Version, expectedVersion, "manifest and package.json versions differ");
	assert.equal(manifest.CodePath, "bin/plugin.cjs", "manifest has an unexpected default entry point");
	assert.equal("CodePathLin" in manifest, false, "manifest must use the portable default entry point");
	assert.equal("CodePathMac" in manifest, false, "manifest must use the portable default entry point");
	assert.equal("CodePathWin" in manifest, false, "manifest must use the portable default entry point");
	assert.equal(manifest.Icon, "icons/plugin", "manifest plugin icon does not match the packaged files");
	assert.equal(manifest.Category, "T3 Code Status", "manifest category differs from the plugin name");
	assert.equal(
		manifest.CategoryIcon,
		"icons/category",
		"manifest category icon does not match the packaged files",
	);
	assert.equal(manifest.SDKVersion, 2, "manifest has an unexpected SDK version");
	assert.deepEqual(manifest.Software, { MinimumVersion: "6.5" }, "manifest has an unexpected host version");
	assert.deepEqual(
		manifest.OS,
		[
			{ Platform: "linux" },
			{ MinimumVersion: "10.15", Platform: "mac" },
			{ MinimumVersion: "10", Platform: "windows" },
		],
		"manifest must declare the supported OpenDeck desktop platforms",
	);
	assert.deepEqual(manifest.Nodejs, { Version: "20" }, "manifest must require the tested Node runtime");
	const actions = Array.isArray(manifest.Actions) ? manifest.Actions : [];
	assert.equal(actions.length, 1, "manifest must contain exactly one focused action");
	const action = actions[0];
	assert.ok(isRecord(action), "manifest action is not an object");
	assert.deepEqual(
		{
			Controllers: action.Controllers,
			DisableAutomaticStates: action.DisableAutomaticStates,
			Icon: action.Icon,
			Name: action.Name,
			PropertyInspectorPath: action.PropertyInspectorPath,
			SupportedInMultiActions: action.SupportedInMultiActions,
			UserTitleEnabled: action.UserTitleEnabled,
			UUID: action.UUID,
		},
		{
			Controllers: ["Keypad"],
			DisableAutomaticStates: true,
			Icon: "icons/action",
			Name: "Thread status",
			PropertyInspectorPath: "property-inspector/index.html",
			SupportedInMultiActions: false,
			UserTitleEnabled: false,
			UUID: ACTION_UUID,
		},
		"manifest thread overview action metadata differs from the packaged files",
	);
	assert.deepEqual(
		action.States,
		[
			{
				FontSize: 0,
				Image: "icons/action",
				ShowTitle: true,
				Title: "Loading T3 Code status",
				TitleAlignment: "middle",
			},
		],
		"manifest must expose dynamic status text without drawing a second visible title",
	);
}

async function verifyAuthFreeBundle(pluginRoot: string): Promise<void> {
	const checkedFiles = [
		"bin/plugin.cjs",
		"property-inspector/index.html",
		"property-inspector/property-inspector.js",
		"property-inspector/styles.css",
	];
	for (const path of checkedFiles) {
		const contents = await readFile(resolve(pluginRoot, path), "utf8");
		for (const marker of LEGACY_AUTH_MARKERS) {
			assert.equal(contents.includes(marker), false, `${path} still contains legacy auth marker ${marker}`);
		}
	}
}

async function smokeTestSetup(setupRoot: string, temporaryRoot: string): Promise<void> {
	const configRoot = resolve(temporaryRoot, "isolated-opendeck");
	const profileDirectory = resolve(configRoot, "profiles", "release-test-deck");
	const profilePath = resolve(profileDirectory, "Default.json");
	await mkdir(profileDirectory, { recursive: true });
	await writeFile(profilePath, `${JSON.stringify({ infobars: [], keys: [null, null], sliders: [] })}\n`);

	const setupUrl = `${pathToFileURL(resolve(setupRoot, "setup-opendeck.mjs")).href}?smoke=${Date.now()}`;
	const setup = (await import(setupUrl)) as SetupModule;
	const result = await setup.setupOpenDeck(
		{ configRoot, dryRun: false },
		{ isOpenDeckRunning: async () => false, platform: "linux" },
	);
	assert.deepEqual(
		{ device: result.device, position: result.position, profile: result.profile },
		{ device: "release-test-deck", position: 0, profile: "Default" },
		"the packaged setup chose an unexpected profile or key",
	);

	const installedPlugin = resolve(configRoot, "plugins", PLUGIN_DIRECTORY);
	await compareTrees(resolve(setupRoot, PLUGIN_DIRECTORY), installedPlugin, "the isolated setup install");
	const profile = parseRecord(await readFile(profilePath, "utf8"), "installed OpenDeck profile");
	const keys = Array.isArray(profile.keys) ? profile.keys : [];
	const firstKey = isRecord(keys[0]) ? keys[0] : undefined;
	const action = firstKey && isRecord(firstKey.action) ? firstKey.action : undefined;
	assert.equal(action?.uuid, ACTION_UUID, "the packaged setup did not place the overview action");
	assert.equal(
		(await readdir(profileDirectory)).filter((name) => name.startsWith("Default.json.backup-")).length,
		1,
		"the packaged setup did not create one profile backup",
	);
}

async function compareTrees(expectedRoot: string, actualRoot: string, label: string): Promise<void> {
	const expectedFiles = await listFiles(expectedRoot);
	assert.deepEqual(
		await listFiles(actualRoot),
		expectedFiles,
		`${label} contains unexpected or missing files`,
	);
	for (const path of expectedFiles) {
		await compareFiles(resolve(expectedRoot, path), resolve(actualRoot, path), `${label} file ${path}`);
	}
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
			} else if (entry.isFile()) {
				files.push(relative(root, path));
			} else {
				throw new Error(`Release contains unsupported entry: ${path}`);
			}
		}
	}
	await visit(root);
	return files.sort();
}

async function compareFiles(expected: string, actual: string, label: string): Promise<void> {
	assert.deepEqual(
		await readFile(actual),
		await readFile(expected),
		`${label} differs from the current build`,
	);
}

async function assertFile(path: string): Promise<void> {
	assert.ok((await stat(path)).isFile(), `required release file is not a regular file: ${path}`);
}

function parseRecord(contents: string, label: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
	if (!isRecord(value)) throw new Error(`${label} is not a JSON object`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) await verifyRelease(projectRoot);
