import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { PLUGIN_DIRECTORY } from "./profile.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginSource = resolve(projectRoot, "plugin");
const distRoot = resolve(projectRoot, "dist");
const outputRoot = resolve(distRoot, PLUGIN_DIRECTORY);
const setupOutput = resolve(projectRoot, "dist", "setup-opendeck.mjs");
const require = createRequire(import.meta.url);
const BUNDLED_DEPENDENCIES = ["snappyjs", "ws"] as const;
const PLUGIN_SOURCE_FILES = [
	"manifest.json",
	"icons/action.svg",
	"icons/category.svg",
	"icons/plugin.png",
	"icons/plugin.svg",
	"icons/plugin@2x.png",
	"property-inspector/index.html",
	"property-inspector/property-inspector.js",
	"property-inspector/styles.css",
] as const;

await rm(distRoot, { force: true, recursive: true });
await mkdir(resolve(outputRoot, "bin"), { recursive: true });
for (const path of PLUGIN_SOURCE_FILES) {
	const destination = resolve(outputRoot, path);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(resolve(pluginSource, path), destination);
}

const manifestPath = resolve(outputRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
await writeFile(manifestPath, JSON.stringify(manifest, null, "\t"));

await build({
	bundle: true,
	entryPoints: [resolve(projectRoot, "src", "index.ts")],
	format: "cjs",
	legalComments: "none",
	minify: false,
	outfile: resolve(outputRoot, "bin", "plugin.cjs"),
	platform: "node",
	target: "node20",
});

await build({
	bundle: true,
	entryPoints: [resolve(projectRoot, "scripts", "setup-opendeck.ts")],
	format: "esm",
	legalComments: "none",
	minify: false,
	outfile: setupOutput,
	platform: "node",
	target: "node20",
});

const license = await readFile(resolve(projectRoot, "LICENSE"), "utf8");
await writeFile(resolve(outputRoot, "LICENSE"), license);
await writeThirdPartyNotices();

console.log(`Plugin gebaut: ${outputRoot}`);
console.log(`OpenDeck-Setup gebaut: ${setupOutput}`);

async function writeThirdPartyNotices(): Promise<void> {
	const packageMetadata = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as unknown;
	const dependencies =
		isRecord(packageMetadata) && isRecord(packageMetadata.dependencies)
			? Object.keys(packageMetadata.dependencies).sort()
			: [];
	if (JSON.stringify(dependencies) !== JSON.stringify([...BUNDLED_DEPENDENCIES].sort())) {
		throw new Error(
			`Update the bundled dependency notices before building. Found: ${dependencies.join(", ") || "none"}.`,
		);
	}

	const sections = ["# Third-party notices", "", "This plugin bundles the following packages.", ""];
	for (const dependency of BUNDLED_DEPENDENCIES) {
		const packagePath = require.resolve(`${dependency}/package.json`);
		const packageMetadata = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
		if (!isRecord(packageMetadata) || typeof packageMetadata.version !== "string") {
			throw new Error(`Cannot read the installed ${dependency} package metadata.`);
		}
		const dependencyLicense = await readFile(resolve(dirname(packagePath), "LICENSE"), "utf8");
		sections.push(`## ${dependency} ${packageMetadata.version}`, "", dependencyLicense.trimEnd(), "");
	}
	await writeFile(resolve(outputRoot, "THIRD_PARTY_NOTICES.md"), `${sections.join("\n")}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
