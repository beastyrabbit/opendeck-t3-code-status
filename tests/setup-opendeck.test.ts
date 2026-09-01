import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	MAX_OPENDECK_PROFILE_DEPTH,
	MAX_OPENDECK_PROFILE_KEYS,
	MAX_OPENDECK_PROFILE_VALUES,
	PLUGIN_DIRECTORY,
} from "../scripts/profile.js";
import {
	defaultOpenDeckConfigRoot,
	MAX_OPENDECK_PROFILE_BYTES,
	MAX_OPENDECK_SELECTOR_BYTES,
	parseSetupArguments,
	type SetupResult,
	setupOpenDeck,
} from "../scripts/setup-opendeck.js";
import { ACTION_UUID } from "../src/types.js";

test("setup installs the plugin and adds one overview to Default", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-setup-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profilePath = join(configRoot, "profiles", "deck-1", "Default.json");
		await createPluginSource(pluginSource, "first build");
		await mkdir(join(configRoot, "profiles", "deck-1"), { recursive: true });
		await writeFile(join(configRoot, "profiles", "deck-1.json"), '{"selected_profile":"HDMI Matrix"}\n');
		await writeFile(
			profilePath,
			`${JSON.stringify({ infobars: [], keys: [{ occupied: true }, null, null], sliders: [] })}\n`,
		);
		await chmod(profilePath, 0o600);

		const firstRun = await runSetup(configRoot, pluginSource);
		assert.equal(firstRun.profile, "Default");
		assert.equal(firstRun.position, 1);
		assert.equal(firstRun.alreadyPresent, false);
		assert.equal(
			await readFile(join(configRoot, "plugins", PLUGIN_DIRECTORY, "bin", "plugin.cjs"), "utf8"),
			"first build",
		);
		await writeFile(join(configRoot, "plugins", PLUGIN_DIRECTORY, "obsolete.txt"), "remove me");

		const firstProfile = JSON.parse(await readFile(profilePath, "utf8")) as {
			keys: Array<{ action?: { uuid?: string }; settings?: { refreshSeconds?: number } } | null>;
		};
		assert.equal(firstProfile.keys[1]?.action?.uuid, ACTION_UUID);
		assert.equal((await stat(profilePath)).mode & 0o777, 0o600);
		firstProfile.keys[1] = {
			...firstProfile.keys[1],
			settings: { refreshSeconds: 90 },
		};
		await writeFile(profilePath, `${JSON.stringify(firstProfile)}\n`);
		await writeFile(join(pluginSource, "bin", "plugin.cjs"), "second build");

		const secondRun = await runSetup(configRoot, pluginSource);
		assert.equal(secondRun.position, 1);
		assert.equal(secondRun.alreadyPresent, true);
		assert.equal(
			await readFile(join(configRoot, "plugins", PLUGIN_DIRECTORY, "bin", "plugin.cjs"), "utf8"),
			"second build",
		);
		await assert.rejects(() => stat(join(configRoot, "plugins", PLUGIN_DIRECTORY, "obsolete.txt")), {
			code: "ENOENT",
		});
		const secondProfile = JSON.parse(await readFile(profilePath, "utf8")) as {
			keys: Array<{ settings?: { refreshSeconds?: number } } | null>;
		};
		assert.equal(secondProfile.keys[1]?.settings?.refreshSeconds, 90);

		const profileFiles = await readdir(join(configRoot, "profiles", "deck-1"));
		assert.equal(profileFiles.filter((name) => name.startsWith("Default.json.backup-")).length, 1);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup dry-run makes no changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-dry-run-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profileDirectory = join(configRoot, "profiles", "deck-1");
		const profilePath = join(profileDirectory, "Default.json");
		await createPluginSource(pluginSource, "dry run build");
		await mkdir(profileDirectory, { recursive: true });
		const profile = `${JSON.stringify({ infobars: [], keys: [null], sliders: [] })}\n`;
		await writeFile(profilePath, profile);

		const result = await runSetup(configRoot, pluginSource, true);
		assert.equal(result.dryRun, true);
		assert.equal(await readFile(profilePath, "utf8"), profile);
		await assert.rejects(() => stat(join(configRoot, "plugins")), { code: "ENOENT" });
		assert.deepEqual(await readdir(profileDirectory), ["Default.json"]);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup has no CLI option that bypasses the running OpenDeck guard", () => {
	assert.throws(() => parseSetupArguments(["--allow-running"]), /Unknown setup option/);
});

test("setup uses XDG_CONFIG_HOME on Linux", () => {
	assert.equal(
		defaultOpenDeckConfigRoot("linux", { XDG_CONFIG_HOME: "/tmp/custom-config" }, "/home/tester"),
		"/tmp/custom-config/opendeck",
	);
	assert.equal(
		defaultOpenDeckConfigRoot("linux", { XDG_CONFIG_HOME: "relative/config" }, "/home/tester"),
		"/home/tester/.config/opendeck",
	);
});

test("setup refuses to change files while OpenDeck is running", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-running-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profileDirectory = join(configRoot, "profiles", "deck-1");
		const profilePath = join(profileDirectory, "Default.json");
		await createPluginSource(pluginSource, "blocked build");
		await mkdir(profileDirectory, { recursive: true });
		const profile = `${JSON.stringify({ infobars: [], keys: [null], sliders: [] })}\n`;
		await writeFile(profilePath, profile);

		await assert.rejects(
			() =>
				setupOpenDeck({ configRoot, dryRun: false, pluginSource }, { isOpenDeckRunning: async () => true }),
			/OpenDeck is running/,
		);
		assert.equal(await readFile(profilePath, "utf8"), profile);
		await assert.rejects(() => stat(join(configRoot, "plugins")), { code: "ENOENT" });
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup rejects a symbolic-link profile", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-profile-symlink-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profileDirectory = join(configRoot, "profiles", "deck-1");
		const redirectedProfile = join(root, "redirected-profile.json");
		await createPluginSource(pluginSource, "blocked build");
		await mkdir(profileDirectory, { recursive: true });
		await writeFile(redirectedProfile, `${JSON.stringify({ keys: [null] })}\n`);
		await symlink(redirectedProfile, join(profileDirectory, "Default.json"));

		await assert.rejects(
			setupOpenDeck({ configRoot, dryRun: false, pluginSource }, { isOpenDeckRunning: async () => false }),
			/OpenDeck profile must be a real file/,
		);
		assert.equal(await readFile(redirectedProfile, "utf8"), `${JSON.stringify({ keys: [null] })}\n`);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup accepts profile and selector files exactly at their byte limits", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-size-boundary-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profileDirectory = join(configRoot, "profiles", "deck-1");
		const profilePath = join(profileDirectory, "Only.json");
		await createPluginSource(pluginSource, "boundary build");
		await mkdir(profileDirectory, { recursive: true });
		await writeFile(
			join(configRoot, "profiles", "deck-1.json"),
			padJsonToBytes({ selected_profile: "Only" }, MAX_OPENDECK_SELECTOR_BYTES),
		);
		await writeFile(profilePath, padJsonToBytes({ keys: [null] }, MAX_OPENDECK_PROFILE_BYTES));

		const result = await runSetup(configRoot, pluginSource, true);
		assert.equal(result.profile, "Only");
		assert.equal(result.position, 0);
		assert.equal(await stat(profilePath).then((metadata) => metadata.size), MAX_OPENDECK_PROFILE_BYTES);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup rejects a selector one byte over its limit before any write", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-selector-limit-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profileDirectory = join(configRoot, "profiles", "deck-1");
		const profilePath = join(profileDirectory, "Only.json");
		await createPluginSource(pluginSource, "blocked selector build");
		await mkdir(profileDirectory, { recursive: true });
		await writeFile(
			join(configRoot, "profiles", "deck-1.json"),
			"not-json".padEnd(MAX_OPENDECK_SELECTOR_BYTES + 1, " "),
		);
		const originalProfile = `${JSON.stringify({ keys: [null] })}\n`;
		await writeFile(profilePath, originalProfile);

		await assert.rejects(() => runSetup(configRoot, pluginSource), /profile selector exceeds .*size limit/);
		await assertNoSetupWrites(configRoot, profilePath, originalProfile);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup rejects a profile one byte over its limit before any write", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-profile-limit-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profileDirectory = join(configRoot, "profiles", "deck-1");
		const profilePath = join(profileDirectory, "Default.json");
		await createPluginSource(pluginSource, "blocked profile build");
		await mkdir(profileDirectory, { recursive: true });
		const oversizedProfile = "not-json".padEnd(MAX_OPENDECK_PROFILE_BYTES + 1, " ");
		await writeFile(profilePath, oversizedProfile);

		await assert.rejects(() => runSetup(configRoot, pluginSource), /profile exceeds .*size limit/);
		await assertNoSetupWrites(configRoot, profilePath, oversizedProfile);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup rechecks the profile byte limit before plugin installation", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-profile-recheck-limit-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profileDirectory = join(configRoot, "profiles", "deck-1");
		const profilePath = join(profileDirectory, "Default.json");
		await createPluginSource(pluginSource, "blocked recheck build");
		await mkdir(profileDirectory, { recursive: true });
		await writeFile(profilePath, JSON.stringify({ keys: [null] }));
		const oversizedProfile = "not-json".padEnd(MAX_OPENDECK_PROFILE_BYTES + 1, " ");

		await assert.rejects(
			() =>
				setupOpenDeck(
					{ configRoot, dryRun: false, pluginSource },
					{
						isOpenDeckRunning: async () => {
							await writeFile(profilePath, oversizedProfile);
							return false;
						},
					},
				),
			/profile exceeds .*size limit/,
		);
		await assertNoSetupWrites(configRoot, profilePath, oversizedProfile);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup rejects an in-limit profile whose placed form would exceed the limit before any write", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-profile-output-limit-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profileDirectory = join(configRoot, "profiles", "deck-1");
		const profilePath = join(profileDirectory, "Default.json");
		await createPluginSource(pluginSource, "blocked output build");
		await mkdir(profileDirectory, { recursive: true });
		const oversizedAfterPlacement = jsonWithStringAtBytes(MAX_OPENDECK_PROFILE_BYTES);
		await writeFile(profilePath, oversizedAfterPlacement);

		await assert.rejects(() => runSetup(configRoot, pluginSource), /Updated OpenDeck profile would exceed/);
		await assertNoSetupWrites(configRoot, profilePath, oversizedAfterPlacement);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup does not accept nested selector data", async () => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-selector-structure-"));
	try {
		const configRoot = join(root, "opendeck");
		const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
		const profileDirectory = join(configRoot, "profiles", "deck-1");
		await createPluginSource(pluginSource, "blocked selector structure build");
		await mkdir(profileDirectory, { recursive: true });
		await writeFile(
			join(configRoot, "profiles", "deck-1.json"),
			JSON.stringify({ metadata: { nested: true }, selected_profile: "First" }),
		);
		await writeFile(join(profileDirectory, "First.json"), JSON.stringify({ keys: [null] }));
		await writeFile(join(profileDirectory, "Second.json"), JSON.stringify({ keys: [null] }));

		await assert.rejects(
			() => runSetup(configRoot, pluginSource),
			/Could not determine the selected profile/,
		);
		await assert.rejects(() => stat(join(configRoot, "plugins")), { code: "ENOENT" });
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("setup rejects profile structure limits before any write", async () => {
	const cases = [
		{
			name: "too-many-keys",
			profile: JSON.stringify({ keys: Array.from({ length: MAX_OPENDECK_PROFILE_KEYS + 1 }, () => null) }),
			expected: /more than .* keys/,
		},
		{
			name: "too-deep",
			profile: deeplyNestedProfile(MAX_OPENDECK_PROFILE_DEPTH + 1),
			expected: /maximum JSON depth/,
		},
		{
			name: "too-many-values",
			profile: JSON.stringify({
				keys: [],
				metadata: Array.from({ length: MAX_OPENDECK_PROFILE_VALUES - 2 }, () => null),
			}),
			expected: /more than .* JSON values/,
		},
	] as const;

	for (const testCase of cases) {
		const root = await mkdtemp(join(tmpdir(), `t3-opendeck-${testCase.name}-`));
		try {
			const configRoot = join(root, "opendeck");
			const pluginSource = join(root, "built", PLUGIN_DIRECTORY);
			const profileDirectory = join(configRoot, "profiles", "deck-1");
			const profilePath = join(profileDirectory, "Default.json");
			await createPluginSource(pluginSource, `blocked ${testCase.name} build`);
			await mkdir(profileDirectory, { recursive: true });
			await writeFile(profilePath, testCase.profile);

			await assert.rejects(() => runSetup(configRoot, pluginSource), testCase.expected);
			await assertNoSetupWrites(configRoot, profilePath, testCase.profile);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	}
});

async function runSetup(configRoot: string, pluginSource: string, dryRun = false): Promise<SetupResult> {
	return setupOpenDeck({ configRoot, dryRun, pluginSource }, { isOpenDeckRunning: async () => false });
}

async function createPluginSource(path: string, bundle: string): Promise<void> {
	await mkdir(join(path, "bin"), { recursive: true });
	await mkdir(join(path, "icons"), { recursive: true });
	await mkdir(join(path, "property-inspector"), { recursive: true });
	await writeFile(
		join(path, "manifest.json"),
		JSON.stringify({
			Actions: [{ UUID: ACTION_UUID }],
			UUID: "com.beastyrabbit.t3-code-status",
		}),
	);
	await writeFile(join(path, "bin", "plugin.cjs"), bundle);
	await writeFile(join(path, "THIRD_PARTY_NOTICES.md"), "test notices");
	await writeFile(join(path, "icons", "action.svg"), "<svg/>");
	await writeFile(join(path, "property-inspector", "index.html"), "<!doctype html>");
	await writeFile(join(path, "property-inspector", "property-inspector.js"), "");
	await writeFile(join(path, "property-inspector", "styles.css"), "");
}

function padJsonToBytes(value: unknown, bytes: number): string {
	const json = JSON.stringify(value);
	assert.ok(Buffer.byteLength(json) <= bytes);
	return `${json}${" ".repeat(bytes - Buffer.byteLength(json))}`;
}

function jsonWithStringAtBytes(bytes: number): string {
	const prefix = '{"keys":[null],"metadata":"';
	const suffix = '"}';
	assert.ok(Buffer.byteLength(prefix) + Buffer.byteLength(suffix) <= bytes);
	return `${prefix}${"x".repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
}

function deeplyNestedProfile(depth: number): string {
	return `{"keys":[],"metadata":${'{"nested":'.repeat(depth - 1)}null${"}".repeat(depth - 1)}}`;
}

async function assertNoSetupWrites(
	configRoot: string,
	profilePath: string,
	originalProfile: string,
): Promise<void> {
	assert.equal(await readFile(profilePath, "utf8"), originalProfile);
	await assert.rejects(() => stat(join(configRoot, "plugins")), { code: "ENOENT" });
	const profileFiles = await readdir(join(configRoot, "profiles", "deck-1"));
	assert.equal(
		profileFiles.some((name) => name.includes(".backup-") || name.endsWith(".tmp")),
		false,
	);
}
