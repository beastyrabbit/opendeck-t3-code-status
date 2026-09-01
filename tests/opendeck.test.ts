import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	canQueueWebSocketMessage,
	isValidOpenDeckContext,
	MAX_OPENDECK_CONTEXT_CODE_UNITS,
	MAX_OPENDECK_LIVE_CONTEXTS,
	MAX_OPENDECK_PENDING_HANDLERS,
	OpenDeckHost,
	parseLaunchArguments,
} from "../src/opendeck.js";

const launchArguments = [
	"-port",
	"3765",
	"-pluginUUID",
	"com.beastyrabbit.t3-code-status",
	"-registerEvent",
	"registerPlugin",
	"-info",
	"{}",
];

async function flushMicrotasks(): Promise<void> {
	for (let iteration = 0; iteration < 4; iteration += 1) await Promise.resolve();
}

test("parseLaunchArguments accepts OpenDeck flags in any order", () => {
	const info = { application: { version: "2.14.0" }, devices: 1 };
	const parsed = parseLaunchArguments([
		"-pluginUUID",
		"com.beastyrabbit.t3-code-status",
		"-info",
		JSON.stringify(info),
		"-registerEvent",
		"registerPlugin",
		"-port",
		"3765",
	]);

	assert.deepEqual(parsed, {
		info,
		pluginUUID: "com.beastyrabbit.t3-code-status",
		port: 3765,
		registerEvent: "registerPlugin",
	});
});

test("websocket backpressure keeps the queued output bounded", () => {
	assert.equal(canQueueWebSocketMessage(0, 256 * 1024), true);
	assert.equal(canQueueWebSocketMessage(256 * 1024 - 1, 1), true);
	assert.equal(canQueueWebSocketMessage(256 * 1024, 1), false);
	assert.equal(canQueueWebSocketMessage(0, 256 * 1024 + 1), false);
	assert.equal(canQueueWebSocketMessage(-1, 1), false);
});

test("OpenDeck context validation accepts the boundary and rejects hostile identifiers", () => {
	assert.equal(isValidOpenDeckContext("context-a"), true);
	assert.equal(isValidOpenDeckContext("x".repeat(MAX_OPENDECK_CONTEXT_CODE_UNITS)), true);
	assert.equal(isValidOpenDeckContext(""), false);
	assert.equal(isValidOpenDeckContext("x".repeat(MAX_OPENDECK_CONTEXT_CODE_UNITS + 1)), false);
	assert.equal(isValidOpenDeckContext(42), false);
});

test("the host bounds retained images and accepts a replacement after cleanup", () => {
	const host = new OpenDeckHost(launchArguments);
	const internals = host as unknown as { desiredImages: Map<string, string> };
	for (let index = 0; index < MAX_OPENDECK_LIVE_CONTEXTS; index += 1) {
		host.setImage(`context-${index}`, `image-${index}`);
	}
	host.setImage("one-context-too-many", "rejected");
	host.setImage("x".repeat(MAX_OPENDECK_CONTEXT_CODE_UNITS + 1), "rejected");

	assert.equal(internals.desiredImages.size, MAX_OPENDECK_LIVE_CONTEXTS);
	assert.equal(internals.desiredImages.has("one-context-too-many"), false);

	host.forgetContext("context-0");
	host.setImage("replacement-context", "replacement");
	assert.equal(internals.desiredImages.size, MAX_OPENDECK_LIVE_CONTEXTS);
	assert.equal(internals.desiredImages.get("replacement-context"), "replacement");
});

test("the host drops excess unresolved event handlers and recovers capacity", async () => {
	const host = new OpenDeckHost(launchArguments);
	const pending: Array<() => void> = [];
	let calls = 0;
	host.onEvent(
		() =>
			new Promise<void>((resolve) => {
				calls += 1;
				pending.push(resolve);
			}),
	);
	const internals = host as unknown as {
		dispatchEvent(event: { event: string }): void;
		pendingEventHandlers: number;
	};

	for (let index = 0; index < MAX_OPENDECK_PENDING_HANDLERS + 20; index += 1) {
		internals.dispatchEvent({ event: "test" });
	}
	assert.equal(calls, MAX_OPENDECK_PENDING_HANDLERS);
	assert.equal(internals.pendingEventHandlers, MAX_OPENDECK_PENDING_HANDLERS);

	pending.shift()?.();
	await flushMicrotasks();
	assert.equal(internals.pendingEventHandlers, MAX_OPENDECK_PENDING_HANDLERS - 1);
	internals.dispatchEvent({ event: "test" });
	assert.equal(calls, MAX_OPENDECK_PENDING_HANDLERS + 1);

	for (const resolve of pending) resolve();
	await flushMicrotasks();
});

describe("parseLaunchArguments validation", () => {
	const valid = launchArguments;

	test("requires every launch flag", () => {
		for (const flag of ["-port", "-pluginUUID", "-registerEvent", "-info"]) {
			const index = valid.indexOf(flag);
			const withoutFlag = valid.filter(
				(_, candidateIndex) => candidateIndex !== index && candidateIndex !== index + 1,
			);
			assert.throws(() => parseLaunchArguments(withoutFlag), new RegExp(`Missing OpenDeck argument ${flag}`));
		}
	});

	test("rejects malformed and out-of-range ports", () => {
		for (const port of ["0", "65536", "12.5", "-1", "not-a-port", "9007199254740992"]) {
			const argumentsList = [...valid];
			argumentsList[1] = port;
			assert.throws(() => parseLaunchArguments(argumentsList), /Invalid OpenDeck argument -port/);
		}
	});

	test("rejects malformed info JSON", () => {
		const argumentsList = [...valid];
		argumentsList[7] = "{not-json";

		assert.throws(() => parseLaunchArguments(argumentsList), /Invalid OpenDeck argument -info/);
	});
});
