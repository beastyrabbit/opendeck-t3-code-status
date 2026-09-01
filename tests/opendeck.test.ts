import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	canQueueWebSocketMessage,
	isValidOpenDeckContext,
	isValidOpenDeckTitle,
	MAX_OPENDECK_CONTEXT_CODE_UNITS,
	MAX_OPENDECK_LIVE_CONTEXTS,
	MAX_OPENDECK_PENDING_HANDLERS,
	MAX_OPENDECK_TITLE_CODE_UNITS,
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

test("OpenDeck title validation accepts the boundary and rejects hostile values", () => {
	assert.equal(isValidOpenDeckTitle("4 of 6 working, 2 waiting"), true);
	assert.equal(isValidOpenDeckTitle("x".repeat(MAX_OPENDECK_TITLE_CODE_UNITS)), true);
	assert.equal(isValidOpenDeckTitle(""), false);
	assert.equal(isValidOpenDeckTitle("x".repeat(MAX_OPENDECK_TITLE_CODE_UNITS + 1)), false);
	assert.equal(isValidOpenDeckTitle(42), false);
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

test("the host sends, deduplicates, restores, and forgets accessible titles", () => {
	const host = new OpenDeckHost(launchArguments);
	const messages: string[] = [];
	const internals = host as unknown as {
		flushStates(): void;
		sentTitles: Map<string, string>;
		socket: { bufferedAmount: number; readyState: number; send(message: string): void };
	};
	internals.socket = {
		bufferedAmount: 0,
		readyState: 1,
		send: (message) => messages.push(message),
	};

	host.setTitle("context-a", "4 of 6 working, 2 waiting");
	host.setTitle("context-a", "4 of 6 working, 2 waiting");
	assert.equal(messages.length, 1);
	assert.deepEqual(JSON.parse(messages[0] ?? "null"), {
		context: "context-a",
		event: "setTitle",
		payload: { target: 0, title: "4 of 6 working, 2 waiting" },
	});

	internals.sentTitles.clear();
	internals.flushStates();
	assert.equal(messages.length, 2);
	host.forgetContext("context-a");
	internals.sentTitles.clear();
	internals.flushStates();
	assert.equal(messages.length, 2);
});

test("the host bounds contexts retained only for accessible titles", () => {
	const host = new OpenDeckHost(launchArguments);
	const internals = host as unknown as { desiredTitles: Map<string, string> };
	for (let index = 0; index < MAX_OPENDECK_LIVE_CONTEXTS; index += 1) {
		host.setTitle(`title-context-${index}`, `title-${index}`);
	}
	host.setTitle("one-context-too-many", "rejected");

	assert.equal(internals.desiredTitles.size, MAX_OPENDECK_LIVE_CONTEXTS);
	assert.equal(internals.desiredTitles.has("one-context-too-many"), false);
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
