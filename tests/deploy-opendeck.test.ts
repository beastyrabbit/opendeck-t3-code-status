import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";

import { type DeployOptions, deployOpenDeck, parseDeployArguments } from "../scripts/deploy-opendeck.js";
import { installPlugin } from "../scripts/plugin-install.js";

async function options(context: TestContext, dryRun = false): Promise<DeployOptions> {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-deploy-"));
	context.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	return {
		configRoot: join(root, "config"),
		dryRun,
		pluginSource: join(root, "plugin"),
	};
}

test("parseDeployArguments supports dry-run and path overrides", () => {
	assert.deepEqual(
		parseDeployArguments([
			"--",
			"--dry-run",
			"--config",
			"./custom-config",
			"--plugin-source",
			"./custom-plugin",
		]),
		{
			configRoot: resolve("custom-config"),
			dryRun: true,
			pluginSource: resolve("custom-plugin"),
		},
	);
	assert.throws(() => parseDeployArguments(["--unknown"]), /Unknown deploy option/);
	assert.throws(() => parseDeployArguments(["--config"]), /Missing value/);
});

test("parseDeployArguments honors only an absolute XDG_CONFIG_HOME", () => {
	assert.equal(
		parseDeployArguments([], { XDG_CONFIG_HOME: "/tmp/custom-config" }, "/home/tester").configRoot,
		"/tmp/custom-config/opendeck",
	);
	assert.equal(
		parseDeployArguments([], { XDG_CONFIG_HOME: "relative/config" }, "/home/tester").configRoot,
		"/home/tester/.config/opendeck",
	);
});

test("dry-run validates and reports a running OpenDeck without changing it", async (context) => {
	const input = await options(context, true);
	const calls: string[] = [];
	const result = await deployOpenDeck(input, {
		findOpenDeckProcesses: async () => [{ executable: "/usr/bin/opendeck", pid: 42 }],
		findRegisteredPluginPids: async () => {
			calls.push("find-plugin");
			return [];
		},
		install: async () => {
			calls.push("install");
		},
		platform: "linux",
		reload: async () => {
			calls.push("reload");
		},
		validate: async () => {
			calls.push("validate");
		},
		waitForReload: async () => {
			calls.push("wait");
			return 0;
		},
		waitForStop: async () => {
			calls.push("wait-stop");
		},
	});

	assert.deepEqual(result, { installedBefore: false, mode: "dry-run", openDeckPid: 42 });
	assert.deepEqual(calls, ["validate"]);
});

test("deploy installs and hot-reloads only the plugin", async (context) => {
	const input = await options(context);
	const calls: string[] = [];
	let processChecks = 0;
	const result = await deployOpenDeck(input, {
		findOpenDeckProcesses: async () => {
			processChecks += 1;
			return [{ executable: "/usr/bin/opendeck", pid: 42 }];
		},
		findRegisteredPluginPids: async (pid) => {
			assert.equal(pid, 42);
			calls.push("find-plugin");
			return [100];
		},
		install: async (source, target, installOptions) => {
			assert.equal(source, input.pluginSource);
			assert.equal(target, join(input.configRoot, "plugins", "com.beastyrabbit.t3-code-status.sdPlugin"));
			calls.push("install");
			await installOptions.afterInstall?.();
		},
		platform: "linux",
		reload: async (executable) => {
			assert.equal(executable, "/usr/bin/opendeck");
			calls.push("reload");
		},
		validate: async () => {
			calls.push("validate");
		},
		waitForReload: async (pid, previousPids) => {
			assert.equal(pid, 42);
			assert.deepEqual([...previousPids], [100]);
			calls.push("wait");
			return 101;
		},
		waitForStop: async () => {
			calls.push("wait-stop");
		},
	});

	assert.deepEqual(result, {
		installedBefore: false,
		mode: "hot-reloaded",
		openDeckPid: 42,
		pluginPid: 101,
	});
	assert.equal(processChecks, 2);
	assert.deepEqual(calls, ["validate", "find-plugin", "install", "reload", "wait"]);
});

test("deploy leaves OpenDeck stopped and never invokes the reload executable", async (context) => {
	const input = await options(context);
	const calls: string[] = [];
	const result = await deployOpenDeck(input, {
		findOpenDeckProcesses: async () => [],
		findRegisteredPluginPids: async () => [],
		install: async () => {
			calls.push("install");
		},
		platform: "linux",
		reload: async () => {
			calls.push("reload");
		},
		validate: async () => {
			calls.push("validate");
		},
		waitForReload: async () => 0,
		waitForStop: async () => undefined,
	});

	assert.deepEqual(result, { installedBefore: false, mode: "installed-stopped" });
	assert.deepEqual(calls, ["validate", "install"]);
});

test("deploy restores and reactivates the previous build when hot reload fails", async (context) => {
	const input = await options(context);
	const target = join(input.configRoot, "plugins", "com.beastyrabbit.t3-code-status.sdPlugin");
	await mkdir(input.pluginSource, { recursive: true });
	await mkdir(target, { recursive: true });
	await writeFile(join(input.pluginSource, "version"), "replacement");
	await writeFile(join(target, "version"), "previous");

	let reloadCalls = 0;
	let pluginPidReads = 0;
	let waitCalls = 0;
	await assert.rejects(
		deployOpenDeck(input, {
			findOpenDeckProcesses: async () => [{ executable: "/usr/bin/opendeck", pid: 42 }],
			findRegisteredPluginPids: async () => {
				pluginPidReads += 1;
				return pluginPidReads === 1 ? [100] : [101];
			},
			install: installPlugin,
			platform: "linux",
			reload: async () => {
				reloadCalls += 1;
			},
			validate: async () => undefined,
			waitForReload: async (_openDeckPid, previousPids) => {
				waitCalls += 1;
				if (waitCalls === 1) throw new Error("injected activation timeout");
				assert.deepEqual([...previousPids], [101]);
				return 102;
			},
			waitForStop: async () => undefined,
		}),
		/previous installation was restored/,
	);
	assert.equal(reloadCalls, 2);
	assert.equal(waitCalls, 2);
	assert.equal(await readFile(join(target, "version"), "utf8"), "previous");
});

test("deploy removes a failed first install and confirms its process stopped", async (context) => {
	const input = await options(context);
	const target = join(input.configRoot, "plugins", "com.beastyrabbit.t3-code-status.sdPlugin");
	await mkdir(input.pluginSource, { recursive: true });
	await writeFile(join(input.pluginSource, "version"), "replacement");
	let reloadCalls = 0;
	let waitForStopCalls = 0;

	await assert.rejects(
		deployOpenDeck(input, {
			findOpenDeckProcesses: async () => [{ executable: "/usr/bin/opendeck", pid: 42 }],
			findRegisteredPluginPids: async () => (reloadCalls === 0 ? [] : [101]),
			install: installPlugin,
			platform: "linux",
			reload: async () => {
				reloadCalls += 1;
			},
			validate: async () => undefined,
			waitForReload: async () => {
				throw new Error("injected activation timeout");
			},
			waitForStop: async (openDeckPid) => {
				assert.equal(openDeckPid, 42);
				waitForStopCalls += 1;
			},
		}),
		/failed activation and was removed/,
	);
	assert.equal(reloadCalls, 2);
	assert.equal(waitForStopCalls, 1);
	await assert.rejects(readFile(join(target, "version"), "utf8"));
});
