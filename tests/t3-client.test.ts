import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import type { CachedT3Shell } from "../src/t3-cache.js";
import { T3CacheError } from "../src/t3-cache.js";
import { summarizeShells, T3Client, T3ClientError } from "../src/t3-client.js";
import type { T3ThreadShell } from "../src/types.js";

const NOW = Date.parse("2030-01-10T12:00:00.000Z");
const LOCAL_ORIGIN = "http://127.0.0.1:3773";

interface TestFiles {
	root: string;
	runtimeFile: string;
	settingsFile: string;
}

async function testFiles(context: TestContext): Promise<TestFiles> {
	const root = await mkdtemp(join(tmpdir(), "opendeck-t3-client-test-"));
	context.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	return {
		root,
		runtimeFile: join(root, "server-runtime.json"),
		settingsFile: join(root, "client-settings.json"),
	};
}

async function writeRuntime(path: string, origin = LOCAL_ORIGIN): Promise<void> {
	await writeFile(path, JSON.stringify({ origin }), "utf8");
}

function environmentFetch(origin = LOCAL_ORIGIN): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? new URL(input.url) : new URL(input);
		assert.equal(url.href, `${origin}/.well-known/t3/environment`);
		assert.equal(new Headers(init?.headers).has("authorization"), false);
		return new Response(JSON.stringify({ environmentId: "local-environment" }), {
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

function thread(overrides: Partial<T3ThreadShell> = {}): T3ThreadShell {
	return {
		id: "thread",
		interactionMode: "default",
		archivedAt: null,
		createdAt: "2030-01-10T10:00:00.000Z",
		settledOverride: "active",
		settledAt: null,
		latestUserMessageAt: "2030-01-10T10:00:00.000Z",
		snoozedAt: null,
		snoozedUntil: null,
		hasPendingApprovals: false,
		hasPendingUserInput: false,
		hasActionableProposedPlan: false,
		backgroundLiveness: null,
		latestTurn: null,
		session: null,
		...overrides,
	};
}

function shell(environmentId: string, threads: T3ThreadShell[]): CachedT3Shell {
	return {
		environmentId,
		snapshot: {
			snapshotSequence: 1,
			threads,
			updatedAt: "2030-01-10T12:00:00.000Z",
		},
	};
}

function expectClientError(code: T3ClientError["code"]): (error: unknown) => boolean {
	return (error: unknown) => {
		assert.ok(error instanceof T3ClientError);
		assert.equal(error.code, code);
		return true;
	};
}

test("aggregates open top-level threads from every cached environment", async (context) => {
	const files = await testFiles(context);
	await writeRuntime(files.runtimeFile);
	await writeFile(files.settingsFile, JSON.stringify({ sidebarAutoSettleAfterDays: 3 }), "utf8");
	const shells = [
		shell("environment-a", [
			thread({ id: "a-running-1", session: { status: "running" } }),
			thread({ id: "a-running-2", backgroundLiveness: "working" }),
			thread({ id: "a-monitoring", backgroundLiveness: "monitoring" }),
			thread({ id: "a-waiting" }),
		]),
		shell("environment-b", [
			thread({ id: "b-running-1", session: { status: "running" } }),
			thread({ id: "b-running-2", backgroundLiveness: "working" }),
			thread({ id: "b-approval", hasPendingApprovals: true, session: { status: "running" } }),
		]),
	];
	let cacheReads = 0;
	const client = new T3Client({
		fetchImpl: environmentFetch(),
		now: () => NOW,
		readShellCache: async () => {
			cacheReads += 1;
			return shells;
		},
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});

	assert.deepEqual(await client.getSnapshot(), {
		connectionStatus: {
			state: "connected",
			origin: LOCAL_ORIGIN,
			environments: 2,
		},
		summary: {
			approval: 1,
			input: 0,
			failed: 0,
			starting: 0,
			working: 4,
			monitoring: 1,
			plan: 0,
			waiting: 1,
			total: 7,
			running: 4,
			attention: 3,
		},
	});
	assert.equal(cacheReads, 1);
});

test("uses T3's default auto-settle setting and honors top-level and legacy wrapped null", async (context) => {
	const files = await testFiles(context);
	await writeRuntime(files.runtimeFile);
	const oldShell = [
		shell("environment-a", [
			thread({
				id: "old-waiting",
				settledOverride: null,
				latestUserMessageAt: "2029-12-01T00:00:00.000Z",
			}),
		]),
	];
	const options = {
		fetchImpl: environmentFetch(),
		now: () => NOW,
		readShellCache: async () => oldShell,
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	};

	assert.equal((await new T3Client(options).getSummary()).total, 0);
	await writeFile(files.settingsFile, JSON.stringify({ sidebarAutoSettleAfterDays: null }), "utf8");
	assert.equal((await new T3Client(options).getSummary()).total, 1);
	await writeFile(
		files.settingsFile,
		JSON.stringify({ settings: { sidebarAutoSettleAfterDays: null } }),
		"utf8",
	);
	assert.equal((await new T3Client(options).getSummary()).total, 1);
});

test("passes a custom cache directory to the cache reader", async (context) => {
	const files = await testFiles(context);
	await writeRuntime(files.runtimeFile);
	const cacheDirectory = join(files.root, "cache");
	let received: { directory?: string } | undefined;
	const client = new T3Client({
		cacheDirectory,
		fetchImpl: environmentFetch(),
		readShellCache: async (options) => {
			received = options;
			return [];
		},
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});

	await client.getSummary();
	assert.deepEqual(received, {
		directory: cacheDirectory,
		environmentId: "local-environment",
	});
});

test("passes the live local environment to automatic cache discovery", async (context) => {
	const files = await testFiles(context);
	await writeRuntime(files.runtimeFile);
	let received: { directory?: string; environmentId?: string } | undefined;
	const client = new T3Client({
		fetchImpl: environmentFetch(),
		readShellCache: async (options) => {
			received = options;
			return [];
		},
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});

	await client.getSummary();
	assert.deepEqual(received, { environmentId: "local-environment" });
});

test("reports an absent or unreachable T3 runtime as offline", async (context) => {
	const files = await testFiles(context);
	const absentClient = new T3Client({
		fetchImpl: environmentFetch(),
		readShellCache: async () => [],
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});
	assert.deepEqual(await absentClient.getConnectionStatus(), { state: "offline" });
	await assert.rejects(absentClient.getSummary(), expectClientError("offline"));

	await writeRuntime(files.runtimeFile);
	const unreachableClient = new T3Client({
		fetchImpl: (async () => {
			throw new Error("connection refused");
		}) as typeof fetch,
		readShellCache: async () => [],
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});
	assert.deepEqual(await unreachableClient.getConnectionStatus(), {
		state: "offline",
		origin: LOCAL_ORIGIN,
	});
	await assert.rejects(unreachableClient.getSummary(), expectClientError("offline"));
});

test("rejects non-local runtime origins before making a request", async (context) => {
	const files = await testFiles(context);
	await writeRuntime(files.runtimeFile, "https://example.com/t3");
	let fetchCalls = 0;
	const client = new T3Client({
		fetchImpl: (async () => {
			fetchCalls += 1;
			return new Response();
		}) as typeof fetch,
		readShellCache: async () => [],
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});

	await assert.rejects(client.getSummary(), expectClientError("unsafe-origin"));
	assert.equal(fetchCalls, 0);
});

test("maps cache failures without exposing their cause", async (context) => {
	const files = await testFiles(context);
	await writeRuntime(files.runtimeFile);
	for (const [source, expected] of [
		[new T3CacheError("unavailable", { cause: new Error("private path") }), "cache-unavailable"],
		[new T3CacheError("corrupt", { cause: new Error("private bytes") }), "cache-read-failed"],
	] as const) {
		const client = new T3Client({
			fetchImpl: environmentFetch(),
			readShellCache: async () => {
				throw source;
			},
			runtimeFile: files.runtimeFile,
			settingsFile: files.settingsFile,
		});
		let caught: unknown;
		try {
			await client.getSummary();
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof T3ClientError);
		assert.equal(caught.code, expected);
		assert.equal(String(caught).includes("private"), false);
	}
});

test("rejects invalid environment and settings data", async (context) => {
	const files = await testFiles(context);
	await writeRuntime(files.runtimeFile);
	const invalidEnvironment = new T3Client({
		fetchImpl: (async () => new Response("{}")) as typeof fetch,
		readShellCache: async () => [],
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});
	await assert.rejects(invalidEnvironment.getSummary(), expectClientError("invalid-response"));

	await writeFile(files.settingsFile, JSON.stringify({ sidebarAutoSettleAfterDays: 0 }), "utf8");
	const invalidSettings = new T3Client({
		fetchImpl: environmentFetch(),
		readShellCache: async () => [],
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});
	await assert.rejects(invalidSettings.getSummary(), expectClientError("invalid-response"));
});

test("bounds local runtime and settings files", async (context) => {
	const files = await testFiles(context);
	await writeFile(files.runtimeFile, Buffer.alloc(16 * 1024 + 1, 0x20));
	const oversizedRuntime = new T3Client({
		fetchImpl: environmentFetch(),
		readShellCache: async () => [],
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});
	await assert.rejects(oversizedRuntime.getSummary(), expectClientError("invalid-response"));

	await writeRuntime(files.runtimeFile);
	await writeFile(files.settingsFile, Buffer.alloc(1024 * 1024 + 1, 0x20));
	const oversizedSettings = new T3Client({
		fetchImpl: environmentFetch(),
		readShellCache: async () => [],
		runtimeFile: files.runtimeFile,
		settingsFile: files.settingsFile,
	});
	await assert.rejects(oversizedSettings.getSummary(), expectClientError("invalid-response"));
});

test("bounds the loopback environment response with and without Content-Length", async (context) => {
	const files = await testFiles(context);
	await writeRuntime(files.runtimeFile);
	for (const response of [
		new Response("{}", { headers: { "content-length": String(64 * 1024 + 1) } }),
		new Response(Buffer.alloc(64 * 1024 + 1, 0x20)),
	]) {
		const client = new T3Client({
			fetchImpl: (async () => response) as typeof fetch,
			readShellCache: async () => [],
			runtimeFile: files.runtimeFile,
			settingsFile: files.settingsFile,
		});
		await assert.rejects(client.getSummary(), expectClientError("invalid-response"));
	}
});

test("summarizeShells does not merge child agents into the thread roster", () => {
	const shells = [shell("environment-a", [thread({ id: "top-level", session: { status: "running" } })])];
	assert.deepEqual(summarizeShells(shells, NOW, 3), {
		approval: 0,
		input: 0,
		failed: 0,
		starting: 0,
		working: 1,
		monitoring: 0,
		plan: 0,
		waiting: 0,
		total: 1,
		running: 1,
		attention: 0,
	});
});
