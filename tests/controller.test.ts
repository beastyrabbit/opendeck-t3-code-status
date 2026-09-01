import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { describe, type TestContext, test } from "node:test";

import { T3CodeController, type T3StatusClient } from "../src/controller.js";
import {
	MAX_OPENDECK_CONTEXT_CODE_UNITS,
	MAX_OPENDECK_LIVE_CONTEXTS,
	type OpenDeckConnection,
	type OpenDeckEvent,
} from "../src/opendeck.js";
import { T3ClientError, type T3ClientSnapshot } from "../src/t3-client.js";
import { ACTION_UUID, type ConnectionStatus, type ThreadSummary } from "../src/types.js";

interface ImageCall {
	context: string;
	image: string;
}

interface InspectorCall {
	action: string;
	context: string;
	payload: object;
}

interface SettingsCall {
	context: string;
	settings: object;
}

interface TitleCall {
	context: string;
	title: string;
}

class FakeHost implements OpenDeckConnection {
	readonly forgotten: string[] = [];
	readonly images: ImageCall[] = [];
	readonly inspectorMessages: InspectorCall[] = [];
	readonly settings: SettingsCall[] = [];
	readonly titles: TitleCall[] = [];

	forgetContext(context: string): void {
		this.forgotten.push(context);
	}

	sendToPropertyInspector(action: string, context: string, payload: object): void {
		this.inspectorMessages.push({ action, context, payload });
	}

	setImage(context: string, image: string): void {
		this.images.push({ context, image });
	}

	setSettings(context: string, settings: object): void {
		this.settings.push({ context, settings });
	}

	setTitle(context: string, title: string): void {
		this.titles.push({ context, title });
	}
}

class FakeClient implements T3StatusClient {
	getConnectionStatusCalls = 0;
	getSummaryCalls = 0;

	onGetConnectionStatus: () => Promise<ConnectionStatus> = async () => ({ state: "offline" });
	onGetSummary: () => Promise<ThreadSummary> = async () => summary();
	snapshotConnectionStatus: ConnectionStatus = {
		state: "connected",
		origin: "http://127.0.0.1:3773",
		environments: 1,
	};

	async getConnectionStatus(): Promise<ConnectionStatus> {
		this.getConnectionStatusCalls += 1;
		return this.onGetConnectionStatus();
	}

	async getSnapshot(): Promise<T3ClientSnapshot> {
		this.getSummaryCalls += 1;
		return {
			connectionStatus: this.snapshotConnectionStatus,
			summary: await this.onGetSummary(),
		};
	}
}

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		total: 6,
		running: 4,
		attention: 2,
		approval: 0,
		input: 0,
		failed: 0,
		starting: 0,
		working: 4,
		monitoring: 0,
		plan: 0,
		waiting: 2,
		...overrides,
	};
}

function event(eventName: string, context = "context-1", payload?: unknown): OpenDeckEvent {
	return {
		action: ACTION_UUID,
		context,
		event: eventName,
		...(payload === undefined ? {} : { payload }),
	};
}

interface Deferred<Value> {
	promise: Promise<Value>;
	reject: (reason?: unknown) => void;
	resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
	let resolve!: (value: Value) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
	for (let iteration = 0; iteration < 8; iteration += 1) await Promise.resolve();
}

function decodeSvg(dataUrl: string): string {
	const prefix = "data:image/svg+xml;base64,";
	assert.ok(dataUrl.startsWith(prefix));
	return Buffer.from(dataUrl.slice(prefix.length), "base64").toString("utf8");
}

function latestSvg(host: FakeHost, context: string): string {
	const call = host.images.findLast((candidate) => candidate.context === context);
	assert.ok(call, `No image was rendered for ${context}`);
	return decodeSvg(call.image);
}

function useMockedIntervals(context: TestContext): void {
	context.mock.timers.enable({ apis: ["setInterval"] });
}

test("willAppear renders loading immediately and then the fetched summary", async (context) => {
	useMockedIntervals(context);
	const host = new FakeHost();
	const client = new FakeClient();
	const pending = deferred<ThreadSummary>();
	client.onGetSummary = () => pending.promise;
	const controller = new T3CodeController(host, client, { now: () => 1_000 });
	context.after(() => controller.dispose());

	await controller.handle(
		event("willAppear", "key-a", { settings: { refreshSeconds: 15, settingsVersion: 1 } }),
	);

	assert.equal(client.getSummaryCalls, 1);
	assert.equal(host.images.length, 1);
	assert.deepEqual(host.titles, [{ context: "key-a", title: "Loading T3 Code status" }]);
	assert.match(latestSvg(host, "key-a"), />···<\/text>/);
	assert.match(latestSvg(host, "key-a"), />LOADING<\/text>/);

	pending.resolve(summary());
	await flushMicrotasks();

	assert.equal(host.images.length, 2);
	assert.deepEqual(host.titles.at(-1), { context: "key-a", title: "4 of 6 working, 2 waiting" });
	assert.match(latestSvg(host, "key-a"), />4\/6<\/text>/);
	assert.match(latestSvg(host, "key-a"), />2 WAITING<\/text>/);
});

test("willAppear migrates the old 15-second default to 60 seconds once", async (context) => {
	useMockedIntervals(context);
	let now = 0;
	const host = new FakeHost();
	const client = new FakeClient();
	const controller = new T3CodeController(host, client, { now: () => now });
	context.after(() => controller.dispose());

	await controller.handle(event("willAppear", "key-a", { settings: { refreshSeconds: 15 } }));
	await flushMicrotasks();

	assert.deepEqual(host.settings, [
		{ context: "key-a", settings: { refreshSeconds: 60, settingsVersion: 1 } },
	]);
	now = 15_000;
	context.mock.timers.tick(15_000);
	assert.equal(client.getSummaryCalls, 1);
	now = 60_000;
	context.mock.timers.tick(45_000);
	assert.equal(client.getSummaryCalls, 2);
});

test("visible contexts share an in-flight status fetch", async (context) => {
	useMockedIntervals(context);
	const host = new FakeHost();
	const client = new FakeClient();
	const pending = deferred<ThreadSummary>();
	client.onGetSummary = () => pending.promise;
	const controller = new T3CodeController(host, client, { now: () => 10_000 });
	context.after(() => controller.dispose());

	await controller.handle(event("willAppear", "key-a"));
	await controller.handle(event("willAppear", "key-b"));

	assert.equal(client.getSummaryCalls, 1);
	pending.resolve(summary({ total: 2, running: 2, attention: 0, working: 2, waiting: 0 }));
	await flushMicrotasks();

	assert.equal(client.getSummaryCalls, 1);
	assert.match(latestSvg(host, "key-a"), />2\/2<\/text>/);
	assert.match(latestSvg(host, "key-b"), />2\/2<\/text>/);
});

test("keyUp during an in-flight poll queues a second fetch and renders its response", async (context) => {
	useMockedIntervals(context);
	const host = new FakeHost();
	const client = new FakeClient();
	const first = deferred<ThreadSummary>();
	const second = deferred<ThreadSummary>();
	client.onGetSummary = () => (client.getSummaryCalls === 1 ? first.promise : second.promise);
	const controller = new T3CodeController(host, client, { now: () => 10_000 });
	context.after(() => controller.dispose());

	await controller.handle(event("willAppear", "key-a"));
	const keyUp = controller.handle(event("keyUp", "key-a"));

	assert.equal(client.getSummaryCalls, 1);
	first.resolve(summary({ total: 1, running: 0, attention: 1, working: 0, waiting: 1 }));
	await flushMicrotasks();

	assert.equal(client.getSummaryCalls, 2);
	assert.match(latestSvg(host, "key-a"), />0\/1<\/text>/);

	second.resolve(summary({ total: 9, running: 9, attention: 0, working: 9, waiting: 0 }));
	await keyUp;
	await flushMicrotasks();

	assert.equal(client.getSummaryCalls, 2);
	assert.match(latestSvg(host, "key-a"), />9\/9<\/text>/);
	assert.match(latestSvg(host, "key-a"), />ALL WORKING<\/text>/);
});

test("a burst of key presses queues at most one follow-up refresh and later input recovers", async (context) => {
	useMockedIntervals(context);
	let now = 0;
	const host = new FakeHost();
	const client = new FakeClient();
	const first = deferred<ThreadSummary>();
	const second = deferred<ThreadSummary>();
	client.onGetSummary = () => (client.getSummaryCalls === 1 ? first.promise : second.promise);
	const controller = new T3CodeController(host, client, { now: () => now });
	context.after(() => controller.dispose());

	controller.handle(event("willAppear", "key-a"));
	for (let index = 0; index < 1_000; index += 1) controller.handle(event("keyUp", "key-a"));
	assert.equal(client.getSummaryCalls, 1);

	first.resolve(summary());
	await flushMicrotasks();
	assert.equal(client.getSummaryCalls, 2);
	for (let index = 0; index < 1_000; index += 1) controller.handle(event("keyUp", "key-a"));
	second.resolve(summary());
	await flushMicrotasks();
	assert.equal(client.getSummaryCalls, 2);

	now = 251;
	client.onGetSummary = async () => summary();
	controller.handle(event("keyUp", "key-a"));
	await flushMicrotasks();
	assert.equal(client.getSummaryCalls, 3);
});

test("duplicate events do not retain promise reactions on an in-flight refresh", async (context) => {
	useMockedIntervals(context);
	const host = new FakeHost();
	const client = new FakeClient();
	const pending = deferred<ThreadSummary>();
	client.onGetSummary = () => pending.promise;
	const controller = new T3CodeController(host, client, { now: () => 0 });
	context.after(() => controller.dispose());

	controller.handle(event("willAppear", "key-a"));
	let promiseResources = 0;
	const hook = createHook({
		init(_asyncId, type) {
			if (type === "PROMISE") promiseResources += 1;
		},
	});
	hook.enable();
	try {
		for (let index = 0; index < 1_000; index += 1) {
			controller.handle(event("willAppear", "key-a"));
		}
	} finally {
		hook.disable();
	}

	assert.equal(promiseResources, 0);
	assert.equal(client.getSummaryCalls, 1);
	pending.resolve(summary());
	await flushMicrotasks();
});

test("visible context retention is bounded and capacity returns after disappearance", async (context) => {
	useMockedIntervals(context);
	const host = new FakeHost();
	const client = new FakeClient();
	const controller = new T3CodeController(host, client);
	context.after(() => controller.dispose());

	for (let index = 0; index < MAX_OPENDECK_LIVE_CONTEXTS; index += 1) {
		controller.handle(event("willAppear", `key-${index}`));
	}
	controller.handle(event("willAppear", "overflow"));
	controller.handle(event("willAppear", "x".repeat(MAX_OPENDECK_CONTEXT_CODE_UNITS + 1)));

	assert.equal(host.images.length, MAX_OPENDECK_LIVE_CONTEXTS);
	assert.equal(
		host.images.some(({ context }) => context === "overflow"),
		false,
	);

	controller.handle(event("willDisappear", "key-0"));
	controller.handle(event("willAppear", "replacement"));
	assert.equal(host.images.length, MAX_OPENDECK_LIVE_CONTEXTS + 1);
	assert.equal(host.images.at(-1)?.context, "replacement");
	await flushMicrotasks();
});

test("the interval refreshes only when due, keyUp refreshes now, and disappearance cleans up", async (context) => {
	useMockedIntervals(context);
	let now = 0;
	const host = new FakeHost();
	const client = new FakeClient();
	const controller = new T3CodeController(host, client, {
		animationIntervalMs: 500,
		now: () => now,
	});
	context.after(() => controller.dispose());

	await controller.handle(event("willAppear", "key-a", { settings: { refreshSeconds: "5" } }));
	await flushMicrotasks();
	assert.equal(client.getSummaryCalls, 1);

	now = 2_500;
	context.mock.timers.tick(500);
	assert.equal(client.getSummaryCalls, 1);
	assert.match(latestSvg(host, "key-a"), /stroke-dashoffset="191\.64"/);

	now = 5_000;
	context.mock.timers.tick(500);
	assert.equal(client.getSummaryCalls, 2);
	await flushMicrotasks();
	assert.match(latestSvg(host, "key-a"), /stroke-dashoffset="383\.27"/);

	now = 5_100;
	await controller.handle(event("keyUp", "key-a"));
	assert.equal(client.getSummaryCalls, 3);

	await controller.handle(event("willDisappear", "key-a"));
	const imageCount = host.images.length;
	now = 20_000;
	context.mock.timers.tick(10_000);
	await flushMicrotasks();
	assert.deepEqual(host.forgotten, ["key-a"]);
	assert.equal(host.images.length, imageCount);
	assert.equal(client.getSummaryCalls, 3);
});

test("the timer ring is quantized and skips identical image renders", async (context) => {
	useMockedIntervals(context);
	let now = 0;
	const host = new FakeHost();
	const client = new FakeClient();
	const controller = new T3CodeController(host, client, { now: () => now });
	context.after(() => controller.dispose());

	await controller.handle(
		event("willAppear", "key-a", { settings: { refreshSeconds: 60, settingsVersion: 1 } }),
	);
	await flushMicrotasks();
	assert.equal(host.images.length, 2);
	assert.equal(host.titles.length, 2);

	now = 1_000;
	context.mock.timers.tick(1_000);
	now = 2_000;
	context.mock.timers.tick(1_000);
	assert.equal(host.images.length, 2);

	now = 3_000;
	context.mock.timers.tick(1_000);
	assert.equal(host.images.length, 3);
	assert.equal(host.titles.length, 2);
	assert.match(latestSvg(host, "key-a"), /stroke-dashoffset="364\.11"/);
});

describe("client error display", () => {
	const cases: Array<{ error: unknown; expected: RegExp; name: string; title: string }> = [
		{
			error: new T3ClientError("offline"),
			expected: />OFF<\/text>/,
			name: "offline",
			title: "T3 Code offline",
		},
		{
			error: new T3ClientError("cache-unavailable"),
			expected: />ERR<\/text>/,
			name: "unavailable cache",
			title: "T3 Code status error",
		},
		{
			error: new T3ClientError("cache-read-failed"),
			expected: />ERR<\/text>/,
			name: "cache read failure",
			title: "T3 Code status error",
		},
		{
			error: new Error("unexpected"),
			expected: />ERR<\/text>/,
			name: "unknown failure",
			title: "T3 Code status error",
		},
	];

	for (const testCase of cases) {
		test(`maps ${testCase.name}`, async (context) => {
			useMockedIntervals(context);
			const host = new FakeHost();
			const client = new FakeClient();
			client.onGetSummary = async () => {
				throw testCase.error;
			};
			const controller = new T3CodeController(host, client, { now: () => 0 });
			context.after(() => controller.dispose());

			await controller.handle(event("willAppear"));
			await flushMicrotasks();

			assert.match(latestSvg(host, "context-1"), testCase.expected);
			assert.equal(host.titles.at(-1)?.title, testCase.title);
		});
	}
});

test("the property inspector receives the read-only connection contract", async () => {
	const host = new FakeHost();
	const client = new FakeClient();
	client.onGetConnectionStatus = async () => ({
		state: "connected",
		origin: "http://127.0.0.1:3773",
		environments: 3,
	});
	const controller = new T3CodeController(host, client);

	await controller.handle(event("propertyInspectorDidAppear", "inspector-a"));
	assert.equal(client.getConnectionStatusCalls, 0);
	await controller.handle(event("sendToPlugin", "inspector-a", { command: "getConnectionStatus" }));
	await flushMicrotasks();

	assert.deepEqual(host.inspectorMessages, [
		{
			action: ACTION_UUID,
			context: "inspector-a",
			payload: {
				busy: false,
				status: {
					state: "connected",
					origin: "http://127.0.0.1:3773",
					environments: 3,
				},
				type: "connectionStatus",
			},
		},
	]);
	await controller.dispose();
});

test("the property inspector rechecks a stale connection without duplicating an immediate request", async () => {
	let now = 0;
	const host = new FakeHost();
	const client = new FakeClient();
	client.onGetConnectionStatus = async () => ({ state: "offline" });
	const controller = new T3CodeController(host, client, { now: () => now });

	await controller.handle(event("propertyInspectorDidAppear", "inspector-a"));
	await controller.handle(event("sendToPlugin", "inspector-a", { command: "getConnectionStatus" }));
	await flushMicrotasks();
	await controller.handle(event("sendToPlugin", "inspector-a", { command: "getConnectionStatus" }));
	assert.equal(client.getConnectionStatusCalls, 1);

	now = 1_001;
	await controller.handle(event("sendToPlugin", "inspector-a", { command: "getConnectionStatus" }));
	await flushMicrotasks();
	assert.equal(client.getConnectionStatusCalls, 2);
	await controller.dispose();
});

test("concurrent property inspector status requests share one cache read", async () => {
	const host = new FakeHost();
	const client = new FakeClient();
	const pending = deferred<ConnectionStatus>();
	client.onGetConnectionStatus = () => pending.promise;
	const controller = new T3CodeController(host, client, { now: () => 10_000 });

	controller.handle(event("sendToPlugin", "inspector-a", { command: "getConnectionStatus" }));
	controller.handle(event("sendToPlugin", "inspector-b", { command: "getConnectionStatus" }));
	assert.equal(client.getConnectionStatusCalls, 1);
	pending.resolve({ state: "offline" });
	await flushMicrotasks();

	assert.equal(client.getConnectionStatusCalls, 1);
	assert.deepEqual(host.inspectorMessages.map(({ context }) => context).sort(), [
		"inspector-a",
		"inspector-b",
	]);
	await controller.dispose();
});

test("status-command bursts are coalesced per inspector and recover after the burst window", async () => {
	let now = 10_000;
	const host = new FakeHost();
	const client = new FakeClient();
	const pending = deferred<ConnectionStatus>();
	client.onGetConnectionStatus = () => pending.promise;
	const controller = new T3CodeController(host, client, { now: () => now });

	for (let index = 0; index < 1_000; index += 1) {
		controller.handle(event("sendToPlugin", "inspector-a", { command: "getConnectionStatus" }));
	}
	assert.equal(client.getConnectionStatusCalls, 1);
	pending.resolve({ state: "offline" });
	await flushMicrotasks();
	assert.equal(host.inspectorMessages.length, 1);

	for (let index = 0; index < 1_000; index += 1) {
		controller.handle(event("sendToPlugin", "inspector-a", { command: "getConnectionStatus" }));
	}
	await flushMicrotasks();
	assert.equal(host.inspectorMessages.length, 1);

	now += 251;
	controller.handle(event("sendToPlugin", "inspector-a", { command: "getConnectionStatus" }));
	await flushMicrotasks();
	assert.equal(client.getConnectionStatusCalls, 1);
	assert.equal(host.inspectorMessages.length, 2);
	await controller.dispose();
});

test("inspector context retention is bounded and ignores unknown command floods", async () => {
	const host = new FakeHost();
	const client = new FakeClient();
	const controller = new T3CodeController(host, client);

	for (let index = 0; index < 1_000; index += 1) {
		controller.handle(event("sendToPlugin", `unknown-${index}`, { command: "unknown" }));
	}
	for (let index = 0; index < MAX_OPENDECK_LIVE_CONTEXTS; index += 1) {
		controller.handle(event("propertyInspectorDidAppear", `inspector-${index}`));
	}
	controller.handle(event("sendToPlugin", "overflow", { command: "getConnectionStatus" }));
	await flushMicrotasks();
	assert.equal(client.getConnectionStatusCalls, 0);

	controller.handle(event("propertyInspectorDidDisappear", "inspector-0"));
	controller.handle(event("sendToPlugin", "overflow", { command: "getConnectionStatus" }));
	await flushMicrotasks();
	assert.equal(client.getConnectionStatusCalls, 1);
	assert.equal(host.inspectorMessages.at(-1)?.context, "overflow");
	await controller.dispose();
});

test("a successful automatic refresh updates an open inspector connection card", async (context) => {
	useMockedIntervals(context);
	const host = new FakeHost();
	const client = new FakeClient();
	const connected: ConnectionStatus = {
		state: "connected",
		origin: "http://127.0.0.1:3773",
		environments: 3,
	};
	client.snapshotConnectionStatus = connected;
	const controller = new T3CodeController(host, client);
	context.after(() => controller.dispose());

	await controller.handle(event("propertyInspectorDidAppear", "inspector-a"));
	await controller.handle(event("willAppear", "key-a"));
	await flushMicrotasks();

	assert.equal(client.getSummaryCalls, 1);
	assert.equal(client.getConnectionStatusCalls, 0);
	assert.deepEqual(
		host.inspectorMessages.map((message) => message.payload),
		[{ busy: false, status: connected, type: "connectionStatus" }],
	);

	await controller.handle(event("sendToPlugin", "inspector-a", { command: "getConnectionStatus" }));
	assert.equal(client.getSummaryCalls, 1);
	assert.equal(client.getConnectionStatusCalls, 0);
});

test("events for another action and events after disposal have no effect", async () => {
	const host = new FakeHost();
	const client = new FakeClient();
	const controller = new T3CodeController(host, client);

	await controller.handle({ ...event("willAppear"), action: "another.action" });
	await controller.dispose();
	await controller.handle(event("willAppear"));

	assert.equal(client.getSummaryCalls, 0);
	assert.deepEqual(host.images, []);
	assert.deepEqual(host.settings, []);
});
