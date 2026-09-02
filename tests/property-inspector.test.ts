import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const inspectorSource = await readFile(
	new URL("../plugin/property-inspector/property-inspector.js", import.meta.url),
	"utf8",
);
const inspectorHtml = await readFile(
	new URL("../plugin/property-inspector/index.html", import.meta.url),
	"utf8",
);

interface FakeElement {
	addEventListener(name: string, listener: () => void): void;
	classList: { toggle(name: string, enabled: boolean): void };
	dataset: Record<string, string>;
	disabled: boolean;
	hidden: boolean;
	hiddenWrites: number;
	textContent: string;
	textContentWrites: number;
	value: string;
}

interface FakeSocket {
	closeCalls: Array<{ code?: number; reason?: string }>;
	emit(name: string, event?: unknown): void;
	open(): void;
	sent: string[];
}

function loadInspector() {
	const elements = new Map<string, FakeElement>();
	for (const id of [
		"status-card",
		"status-dial",
		"status-light",
		"connection-state",
		"connection-detail",
		"error-message",
		"refresh-seconds",
		"refresh-note",
	]) {
		let hidden = true;
		let textContent = "";
		const element: FakeElement = {
			addEventListener: () => undefined,
			classList: { toggle: () => undefined },
			dataset: {},
			disabled: id === "refresh-seconds",
			get hidden() {
				return hidden;
			},
			set hidden(value) {
				hidden = value;
				this.hiddenWrites += 1;
			},
			hiddenWrites: 0,
			get textContent() {
				return textContent;
			},
			set textContent(value) {
				textContent = value;
				this.textContentWrites += 1;
			},
			textContentWrites: 0,
			value: id === "refresh-seconds" ? "60" : "",
		};
		elements.set(id, element);
	}

	const sockets: Array<{
		closeCalls: Array<{ code?: number; reason?: string }>;
		emit(name: string, event?: unknown): void;
		open(): void;
		readyState: number;
		sent: string[];
	}> = [];
	class FakeWebSocket {
		static readonly OPEN = 1;
		readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
		readonly listeners = new Map<string, Array<(event: unknown) => void>>();
		readonly sent: string[] = [];
		readyState = 0;

		constructor() {
			sockets.push(this);
		}

		addEventListener(name: string, listener: (event: unknown) => void): void {
			const listeners = this.listeners.get(name) ?? [];
			listeners.push(listener);
			this.listeners.set(name, listeners);
		}

		close(code?: number, reason?: string): void {
			this.closeCalls.push({ code, reason });
			this.readyState = 3;
			this.emit("close");
		}

		emit(name: string, event: unknown = {}): void {
			for (const listener of this.listeners.get(name) ?? []) listener(event);
		}

		open(): void {
			this.readyState = FakeWebSocket.OPEN;
			this.emit("open");
		}

		send(message: string): void {
			this.sent.push(message);
		}
	}

	const window: Record<string, unknown> = {};
	runInNewContext(inspectorSource, {
		document: {
			getElementById: (id: string) => elements.get(id),
			querySelector: (selector: string) =>
				selector === ".status-card" ? elements.get("status-card") : undefined,
		},
		WebSocket: FakeWebSocket,
		window,
	});

	return {
		connect: window.connectElgatoStreamDeckSocket as (
			port: number,
			propertyInspectorUuid: string,
			registerEvent: string,
			info: string,
			actionInfo: string,
		) => void,
		elements,
		socket: (): FakeSocket | undefined => sockets[0],
	};
}

test("the property inspector reports malformed or invalid action data", () => {
	for (const actionInfo of ["{", "null", "[]", '"text"', "42"]) {
		const { connect, elements } = loadInspector();
		assert.doesNotThrow(() => connect(1234, "pi-context", "registerPropertyInspector", "{}", actionInfo));
		assert.equal(elements.get("connection-state")?.textContent, "Settings unavailable");
		assert.equal(
			elements.get("connection-detail")?.textContent,
			"Close and reopen this settings panel. If the problem continues, restart OpenDeck.",
		);
		assert.equal(elements.get("error-message")?.textContent, "OpenDeck sent invalid action data.");
		assert.equal(elements.get("error-message")?.hidden, false);
		assert.equal(elements.get("status-card")?.dataset.state, "error");
		assert.equal(elements.get("refresh-seconds")?.disabled, true);
	}
});

test("the refresh interval stays disabled until the OpenDeck socket is ready", () => {
	assert.match(inspectorHtml, /id="refresh-seconds"[\s\S]*?disabled[\s\S]*?aria-label=/);
	const { connect, elements, socket } = loadInspector();
	connect(
		1234,
		"pi-context",
		"registerPropertyInspector",
		"{}",
		JSON.stringify({ context: "action-context", payload: { settings: { refreshSeconds: 90 } } }),
	);
	assert.equal(elements.get("refresh-seconds")?.disabled, true);
	assert.equal(elements.get("refresh-seconds")?.value, "90");
	const connection = socket();
	assert.ok(connection);
	connection.open();
	assert.equal(elements.get("refresh-seconds")?.disabled, false);
});

test("connection updates use one atomic live region for status, detail, and recovery guidance", () => {
	assert.match(
		inspectorHtml,
		/id="connection-announcement" role="status" aria-live="polite" aria-atomic="true"[\s\S]*?id="connection-state"[\s\S]*?id="connection-detail"[\s\S]*?id="error-message"[\s\S]*?<\/div>/,
	);
	assert.doesNotMatch(inspectorHtml, /id="connection-state"[^>]*aria-live=/);
	assert.doesNotMatch(inspectorHtml, /id="error-message"[^>]*role="alert"/);
});

test("unchanged connection updates do not mutate the live region again", () => {
	const { connect, elements, socket } = loadInspector();
	connect(
		1234,
		"pi-context",
		"registerPropertyInspector",
		"{}",
		JSON.stringify({ context: "action-context", payload: { settings: {} } }),
	);
	const connection = socket();
	assert.ok(connection);
	connection.open();

	const message = {
		data: JSON.stringify({
			event: "sendToPropertyInspector",
			payload: { status: { environments: 2, state: "connected" }, type: "connectionStatus" },
		}),
	};
	connection.emit("message", message);

	const state = elements.get("connection-state");
	const detail = elements.get("connection-detail");
	const error = elements.get("error-message");
	assert.ok(state);
	assert.ok(detail);
	assert.ok(error);
	const writes = {
		state: state.textContentWrites,
		detail: detail.textContentWrites,
		errorText: error.textContentWrites,
		errorHidden: error.hiddenWrites,
	};

	connection.emit("message", message);

	assert.deepEqual(
		{
			state: state.textContentWrites,
			detail: detail.textContentWrites,
			errorText: error.textContentWrites,
			errorHidden: error.hiddenWrites,
		},
		writes,
	);
});

test("visible connection changes still update the live region", () => {
	const { connect, elements, socket } = loadInspector();
	connect(
		1234,
		"pi-context",
		"registerPropertyInspector",
		"{}",
		JSON.stringify({ context: "action-context", payload: { settings: {} } }),
	);
	const connection = socket();
	assert.ok(connection);
	connection.open();

	const sendStatus = (payload: Record<string, unknown>) => {
		connection.emit("message", {
			data: JSON.stringify({ event: "sendToPropertyInspector", payload }),
		});
	};
	const state = elements.get("connection-state");
	const detail = elements.get("connection-detail");
	const error = elements.get("error-message");
	assert.ok(state);
	assert.ok(detail);
	assert.ok(error);

	sendStatus({
		status: { environments: 2, state: "connected" },
		type: "connectionStatus",
	});
	const connectedWrites = state.textContentWrites + detail.textContentWrites;
	sendStatus({
		status: { environments: 3, state: "connected" },
		type: "connectionStatus",
	});
	assert.equal(state.textContent, "Connected");
	assert.equal(detail.textContent, "3 Environments · local cache · no sign-in");
	assert.equal(state.textContentWrites + detail.textContentWrites, connectedWrites + 1);

	sendStatus({
		error: "cache-unavailable",
		status: { environments: 0, state: "offline" },
		type: "connectionStatus",
	});
	assert.equal(state.textContent, "Cache unavailable");
	assert.equal(detail.textContent, "Thread status cannot update until the local cache is available.");
	assert.equal(error.textContent, "The local T3 thread cache could not be opened.");
	assert.equal(error.hidden, false);

	sendStatus({
		status: { environments: 3, state: "connected" },
		type: "connectionStatus",
	});
	assert.equal(state.textContent, "Connected");
	assert.equal(detail.textContent, "3 Environments · local cache · no sign-in");
	assert.equal(error.textContent, "");
	assert.equal(error.hidden, true);
});

test("websocket errors and normal closes disable settings without duplicate recovery updates", () => {
	const connectInspector = () => {
		const inspector = loadInspector();
		inspector.connect(
			1234,
			"pi-context",
			"registerPropertyInspector",
			"{}",
			JSON.stringify({ context: "action-context", payload: { settings: {} } }),
		);
		const connection = inspector.socket();
		assert.ok(connection);
		connection.open();
		assert.equal(inspector.elements.get("refresh-seconds")?.disabled, false);
		return { ...inspector, connection };
	};

	const failed = connectInspector();
	failed.connection.emit("error");
	assert.equal(failed.elements.get("refresh-seconds")?.disabled, true);
	assert.equal(failed.elements.get("connection-state")?.textContent, "OpenDeck disconnected");
	assert.equal(
		failed.elements.get("connection-detail")?.textContent,
		"Close and reopen this settings panel after OpenDeck reconnects.",
	);
	assert.equal(
		failed.elements.get("error-message")?.textContent,
		"OpenDeck could not connect this settings panel to the plugin.",
	);

	failed.connection.emit("close");
	assert.equal(
		failed.elements.get("error-message")?.textContent,
		"OpenDeck could not connect this settings panel to the plugin.",
	);

	const closed = connectInspector();
	closed.connection.emit("close");
	assert.equal(closed.elements.get("refresh-seconds")?.disabled, true);
	assert.equal(closed.elements.get("connection-state")?.textContent, "OpenDeck disconnected");
	assert.equal(closed.elements.get("error-message")?.textContent, "The connection to OpenDeck was closed.");
});

test("the property inspector rejects oversized startup data before opening a socket", () => {
	const { connect, elements, socket } = loadInspector();
	connect(1234, "pi-context", "registerPropertyInspector", "{}", "x".repeat(64 * 1024 + 1));

	assert.equal(socket(), undefined);
	assert.equal(elements.get("connection-state")?.textContent, "Settings unavailable");
	assert.equal(elements.get("error-message")?.textContent, "OpenDeck sent invalid or oversized action data.");
	assert.equal(elements.get("refresh-seconds")?.disabled, true);
});

test("malformed bounded messages are ignored and a later valid message still renders", () => {
	const { connect, elements, socket } = loadInspector();
	connect(
		1234,
		"pi-context",
		"registerPropertyInspector",
		"{}",
		JSON.stringify({ context: "action-context", payload: { settings: {} } }),
	);
	const connection = socket();
	assert.ok(connection);
	connection.open();

	assert.doesNotThrow(() => {
		connection.emit("message", { data: "{" });
		connection.emit("message", { data: "null" });
		connection.emit("message", { data: "[]" });
	});
	connection.emit("message", {
		data: JSON.stringify({
			event: "sendToPropertyInspector",
			payload: { status: { environments: 2, state: "connected" }, type: "connectionStatus" },
		}),
	});

	assert.equal(elements.get("connection-state")?.textContent, "Connected");
	assert.equal(elements.get("connection-detail")?.textContent, "2 Environments · local cache · no sign-in");
	assert.deepEqual(connection.closeCalls, []);
});

test("an oversized websocket message closes the connection with a bounded local error", () => {
	const { connect, elements, socket } = loadInspector();
	connect(1234, "pi-context", "registerPropertyInspector", "{}", JSON.stringify({ context: "action" }));
	const connection = socket();
	assert.ok(connection);
	connection.open();
	connection.emit("message", { data: "x".repeat(64 * 1024 + 1) });

	assert.deepEqual(connection.closeCalls, [{ code: 1009, reason: "Settings input limit exceeded" }]);
	assert.equal(
		elements.get("error-message")?.textContent,
		"OpenDeck sent an oversized or unsupported settings message.",
	);
	assert.equal(elements.get("refresh-seconds")?.disabled, true);

	connection.emit("message", {
		data: JSON.stringify({ event: "didReceiveSettings", payload: { settings: { refreshSeconds: 90 } } }),
	});
	assert.equal(elements.get("refresh-seconds")?.value, "60");
});

test("a websocket message flood is cut off before unbounded parsing work accumulates", () => {
	const { connect, elements, socket } = loadInspector();
	connect(1234, "pi-context", "registerPropertyInspector", "{}", JSON.stringify({ context: "action" }));
	const connection = socket();
	assert.ok(connection);
	connection.open();

	for (let index = 0; index < 61; index += 1) connection.emit("message", { data: "{}" });

	assert.deepEqual(connection.closeCalls, [{ code: 1009, reason: "Settings input limit exceeded" }]);
	assert.equal(elements.get("error-message")?.textContent, "OpenDeck sent settings messages too quickly.");
	assert.equal(elements.get("refresh-seconds")?.disabled, true);
});
