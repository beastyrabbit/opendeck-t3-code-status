import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { installPlugin } from "../scripts/plugin-install.js";

test("installPlugin stages and replaces an existing plugin directory", async (context: TestContext) => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-plugin-install-"));
	context.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	const source = join(root, "source");
	const target = join(root, "plugins", "com.beastyrabbit.t3-code-status.sdPlugin");
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "version"), "first");

	await installPlugin(source, target);
	assert.equal(await readFile(join(target, "version"), "utf8"), "first");

	await writeFile(join(source, "version"), "second");
	await installPlugin(source, target);

	assert.equal(await readFile(join(target, "version"), "utf8"), "second");
	assert.deepEqual((await readdir(join(root, "plugins"))).sort(), [
		"com.beastyrabbit.t3-code-status.sdPlugin",
	]);
});

test("installPlugin restores the previous directory when replacement fails", async (context: TestContext) => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-plugin-install-rollback-"));
	context.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	const source = join(root, "source");
	const target = join(root, "plugins", "com.beastyrabbit.t3-code-status.sdPlugin");
	await mkdir(source, { recursive: true });
	await mkdir(target, { recursive: true });
	await writeFile(join(source, "version"), "replacement");
	await writeFile(join(target, "version"), "previous");
	let renameCalls = 0;

	await assert.rejects(
		installPlugin(
			source,
			target,
			{},
			{
				rename: async (from, to) => {
					renameCalls += 1;
					if (renameCalls === 2) throw new Error("injected replacement failure");
					await rename(from, to);
				},
			},
		),
		/previous installation was restored/,
	);

	assert.equal(renameCalls, 3);
	assert.equal(await readFile(join(target, "version"), "utf8"), "previous");
	assert.deepEqual((await readdir(join(root, "plugins"))).sort(), [
		"com.beastyrabbit.t3-code-status.sdPlugin",
	]);
});

test("installPlugin restores the previous directory when activation fails", async (context: TestContext) => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-plugin-activation-rollback-"));
	context.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	const source = join(root, "source");
	const target = join(root, "plugins", "com.beastyrabbit.t3-code-status.sdPlugin");
	await mkdir(source, { recursive: true });
	await mkdir(target, { recursive: true });
	await writeFile(join(source, "version"), "replacement");
	await writeFile(join(target, "version"), "previous");

	let rollbackObserved = false;
	await assert.rejects(
		installPlugin(source, target, {
			afterInstall: async () => {
				throw new Error("injected activation failure");
			},
			afterRollback: async (restoredPrevious) => {
				assert.equal(restoredPrevious, true);
				assert.equal(await readFile(join(target, "version"), "utf8"), "previous");
				rollbackObserved = true;
			},
		}),
		/previous installation was restored/,
	);
	assert.equal(rollbackObserved, true);
	assert.equal(await readFile(join(target, "version"), "utf8"), "previous");
	assert.deepEqual(await readdir(join(root, "plugins")), ["com.beastyrabbit.t3-code-status.sdPlugin"]);
});

test("installPlugin reports when the restored build cannot be reactivated", async (context: TestContext) => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-plugin-reactivation-failure-"));
	context.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	const source = join(root, "source");
	const target = join(root, "plugins", "com.beastyrabbit.t3-code-status.sdPlugin");
	await mkdir(source, { recursive: true });
	await mkdir(target, { recursive: true });
	await writeFile(join(source, "version"), "replacement");
	await writeFile(join(target, "version"), "previous");

	await assert.rejects(
		installPlugin(source, target, {
			afterInstall: async () => {
				throw new Error("injected activation failure");
			},
			afterRollback: async () => {
				throw new Error("injected reactivation failure");
			},
		}),
		(error: unknown) =>
			error instanceof AggregateError &&
			/previous installation files were restored, but OpenDeck could not reactivate them/.test(error.message),
	);
	assert.equal(await readFile(join(target, "version"), "utf8"), "previous");
});

test("installPlugin removes a first install before running rollback cleanup", async (context: TestContext) => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-plugin-first-activation-failure-"));
	context.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	const source = join(root, "source");
	const plugins = join(root, "plugins");
	const target = join(plugins, "com.beastyrabbit.t3-code-status.sdPlugin");
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "version"), "replacement");
	let cleanupObserved = false;

	await assert.rejects(
		installPlugin(source, target, {
			afterInstall: async () => {
				throw new Error("injected activation failure");
			},
			afterRollback: async (restoredPrevious) => {
				assert.equal(restoredPrevious, false);
				await assert.rejects(readFile(join(target, "version"), "utf8"));
				cleanupObserved = true;
			},
		}),
		/failed activation and was removed/,
	);
	assert.equal(cleanupObserved, true);
	assert.deepEqual(await readdir(plugins), []);
});

test("installPlugin rejects a symbolic-link destination", async (context: TestContext) => {
	const root = await mkdtemp(join(tmpdir(), "t3-opendeck-plugin-symlink-"));
	context.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	const source = join(root, "source");
	const redirected = join(root, "redirected");
	const plugins = join(root, "plugins");
	await mkdir(source);
	await mkdir(redirected);
	await writeFile(join(source, "version"), "replacement");
	await symlink(redirected, plugins, "dir");

	await assert.rejects(
		installPlugin(source, join(plugins, "com.beastyrabbit.t3-code-status.sdPlugin")),
		/must be a real directory/,
	);
	assert.deepEqual(await readdir(redirected), []);
});
