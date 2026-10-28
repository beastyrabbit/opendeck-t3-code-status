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
	emit(name: string): void;
	replaceChildren(...children: unknown[]): void;
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
		"display-field",
		"action-note",
		"display-mode",
		"display-note",
		"theme",
		"pairing-link",
		"allow-http",
		"pair-button",
		"ssh-hosts",
		"ssh-pair-button",
		"ssh-find-button",
		"pairing-result",
		"ssh-result",
		"environment-list",
		"environment-detail",
		"remove-connection",
	]) {
		let hidden = true;
		let textContent = "";
		const listeners = new Map<string, () => void>();
		const element: FakeElement = {
			addEventListener: (name, listener) => {
				listeners.set(name, listener);
			},
			emit: (name) => {
				listeners.get(name)?.();
			},
			classList: { toggle: () => undefined },
			replaceChildren: () => undefined,
			dataset: {},
			disabled: id === "display-mode" || id === "theme",
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
			value: id === "display-mode" ? "60" : "",
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
			createElement: () => ({}),
			getElementById: (id: string) => elements.get(id),
			querySelector: (selector: string) =>
				selector === ".status-card" ? elements.get("status-card") : undefined,
		},
		URL,
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

test("Overview keys hide the display choice and talk to the plugin as their own action", () => {
	const { connect, elements, socket } = loadInspector();
	connect(
		1234,
		"pi-context",
		"registerPropertyInspector",
		"{}",
		JSON.stringify({
			action: "com.beastyrabbit.t3-code-status.overview-tile",
			context: "key-a",
			payload: { settings: { theme: "gauge" } },
		}),
	);
	assert.equal(elements.get("display-field")?.hidden, true);
	assert.equal(elements.get("action-note")?.hidden, false);
	assert.match(elements.get("action-note")?.textContent ?? "", /four counts on one key/);
	assert.equal(elements.get("theme")?.value, "gauge");
	const connection = socket();
	assert.ok(connection);
	connection.open();
	assert.equal(
		JSON.parse(connection.sent.at(-1) ?? "").action,
		"com.beastyrabbit.t3-code-status.overview-tile",
	);
});

test("an unknown action shows the Thread status settings", () => {
	const { connect, elements } = loadInspector();
	connect(
		1234,
		"pi-context",
		"registerPropertyInspector",
		"{}",
		JSON.stringify({ action: "constructor", context: "key-a", payload: { settings: {} } }),
	);
	assert.equal(elements.get("display-field")?.hidden, false);
	assert.equal(elements.get("action-note")?.hidden, true);
});

test("display changes restore saved modes", () => {
	const { connect, elements, socket } = loadInspector();
	connect(
		1234,
		"pi-context",
		"registerPropertyInspector",
		"{}",
		JSON.stringify({
			context: "key-a",
			payload: { settings: { displayMode: "questions", refreshSeconds: 90 } },
		}),
	);
	const connection = socket();
	assert.ok(connection);
	const mode = elements.get("display-mode");
	assert.ok(mode);
	const theme = elements.get("theme");
	assert.ok(theme);
	assert.equal(mode.disabled, true);
	// Displays saved by earlier versions map to their new key types.
	assert.equal(mode.value, "needs");
	assert.equal(theme.value, "counter");
	connection.open();
	assert.equal(mode.disabled, false);
	assert.equal(theme.disabled, false);
	mode.value = "approval";
	mode.emit("change");
	assert.deepEqual(JSON.parse(connection.sent.at(-1) ?? ""), {
		event: "setSettings",
		context: "key-a",
		payload: { displayMode: "approval", theme: "counter", settingsVersion: 2 },
	});
	theme.value = "flood";
	theme.emit("change");
	assert.deepEqual(JSON.parse(connection.sent.at(-1) ?? "").payload, {
		displayMode: "approval",
		theme: "flood",
		settingsVersion: 2,
	});
	theme.value = "unknown";
	mode.value = "constructor";
	mode.emit("change");
	assert.deepEqual(JSON.parse(connection.sent.at(-1) ?? "").payload, {
		displayMode: "combined",
		theme: "counter",
		settingsVersion: 2,
	});
	connection.emit("close");
	assert.equal(mode.disabled, true);
	assert.equal(theme.disabled, true);
});

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
		assert.equal(elements.get("display-mode")?.disabled, true);
	}
});

test("pairing sends a transient command, clears the secret, and keeps it out of key settings", () => {
	const { connect, elements, socket } = loadInspector();
	connect(1234, "pi-context", "registerPropertyInspector", "{}", JSON.stringify({ context: "key-a" }));
	const connection = socket();
	assert.ok(connection);
	connection.open();
	const link = elements.get("pairing-link");
	const button = elements.get("pair-button");
	assert.ok(link);
	assert.ok(button);
	link.value = "http://127.0.0.1:3773/pair#token=fixture";
	button.emit("click");
	const message = JSON.parse(connection.sent.at(-1) ?? "");
	assert.equal(message.event, "sendToPlugin");
	assert.equal(message.payload.command, "pair");
	assert.equal(message.payload.link, "http://127.0.0.1:3773/pair#token=fixture");
	assert.equal(link.value, "");
	assert.equal(button.disabled, true);
	connection.emit("message", {
		data: JSON.stringify({
			event: "sendToPropertyInspector",
			payload: { type: "pairingResult", error: "invalid-link" },
		}),
	});
	assert.equal(button.disabled, false);
	assert.equal(
		elements.get("pairing-result")?.textContent,
		"Paste the complete pairing link, including its token.",
	);
	const mode = elements.get("display-mode");
	assert.ok(mode);
	mode.value = "questions";
	mode.emit("change");
	assert.doesNotMatch(connection.sent.at(-1) ?? "", /fixture|token|pairing/);
});

test("SSH pairing lists the paired remote machines, sends the hosts, and reports each machine", () => {
	const { connect, elements, socket } = loadInspector();
	connect(1234, "pi-context", "registerPropertyInspector", "{}", JSON.stringify({ context: "key-a" }));
	const connection = socket();
	assert.ok(connection);
	connection.open();
	const hosts = elements.get("ssh-hosts");
	const button = elements.get("ssh-pair-button");
	assert.ok(hosts);
	assert.ok(button);
	const status = (origins: string[]) =>
		connection.emit("message", {
			data: JSON.stringify({
				event: "sendToPropertyInspector",
				payload: {
					type: "connectionStatus",
					busy: false,
					status: {
						state: "connected",
						connections: origins.map((origin, index) => ({
							environmentId: `env-${index}`,
							label: `Env ${index}`,
							origin,
							expiresAt: 0,
							state: "connected",
						})),
					},
				},
			}),
		});
	status(["http://127.0.0.1:3773", "http://anvil:3773", "http://devbox:3774", "https://t3.example.com"]);
	assert.equal(hosts.value, "anvil, devbox:3774");
	hosts.value = "anvil, kiln";
	hosts.emit("input");
	status(["http://anvil:3773"]);
	assert.equal(hosts.value, "anvil, kiln");
	button.emit("click");
	const message = JSON.parse(connection.sent.at(-1) ?? "");
	assert.equal(message.payload.command, "pairSsh");
	assert.equal(message.payload.hosts, "anvil, kiln");
	assert.equal(button.disabled, true);
	connection.emit("message", {
		data: JSON.stringify({
			event: "sendToPropertyInspector",
			payload: { type: "pairingResult", hosts: [{ host: "anvil" }, { host: "kiln", error: "ssh-failed" }] },
		}),
	});
	assert.equal(button.disabled, false);
	assert.equal(elements.get("ssh-result")?.textContent, "Paired anvil.\nkiln: SSH login failed");
});

test("Find adds the T3 machines found on the tailnet to the SSH host list", () => {
	const { connect, elements, socket } = loadInspector();
	connect(1234, "pi-context", "registerPropertyInspector", "{}", JSON.stringify({ context: "key-a" }));
	const connection = socket();
	assert.ok(connection);
	connection.open();
	const hosts = elements.get("ssh-hosts");
	const find = elements.get("ssh-find-button");
	assert.ok(hosts);
	assert.ok(find);
	hosts.value = "anvil";
	find.emit("click");
	assert.equal(JSON.parse(connection.sent.at(-1) ?? "").payload.command, "discoverHosts");
	assert.equal(find.disabled, true);
	const result = (found: unknown) =>
		connection.emit("message", {
			data: JSON.stringify({
				event: "sendToPropertyInspector",
				payload: { type: "discoveryResult", hosts: found },
			}),
		});
	result(["anvil", "kiln", "mac-mini"]);
	assert.equal(find.disabled, false);
	assert.equal(hosts.value, "anvil, kiln, mac-mini");
	assert.equal(elements.get("ssh-result")?.textContent, "Found 3 machines. Press Pair all.");
	result([]);
	assert.equal(hosts.value, "anvil, kiln, mac-mini");
	assert.match(elements.get("ssh-result")?.textContent ?? "", /^No T3 Code found on Tailscale/);
	// Pair all takes at most 16 machines, so the list never grows past that.
	result(Array.from({ length: 20 }, (_, index) => `host-${index}`));
	assert.equal(hosts.value.split(", ").length, 16);
	assert.equal(hosts.value.split(", ").slice(0, 3).join(", "), "anvil, kiln, mac-mini");
	assert.equal(
		elements.get("ssh-result")?.textContent,
		"Found 20 machines. Pair all takes 16 at a time; 7 did not fit in the list.",
	);
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
	assert.equal(detail.textContent, "3 Environments · live stream · read only");
	assert.equal(state.textContentWrites + detail.textContentWrites, connectedWrites + 1);

	sendStatus({
		error: "authorization-required",
		status: { environments: 0, state: "authorization-required" },
		type: "connectionStatus",
	});
	assert.equal(state.textContent, "Pairing needed");
	assert.equal(
		detail.textContent,
		"Authorization expired or was revoked. Paste a fresh read-only pairing link.",
	);
	assert.equal(error.textContent, "");
	assert.equal(error.hidden, true);

	sendStatus({
		status: { environments: 3, state: "connected" },
		type: "connectionStatus",
	});
	assert.equal(state.textContent, "Connected");
	assert.equal(detail.textContent, "3 Environments · live stream · read only");
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
		assert.equal(inspector.elements.get("display-mode")?.disabled, false);
		return { ...inspector, connection };
	};

	const failed = connectInspector();
	failed.connection.emit("error");
	assert.equal(failed.elements.get("display-mode")?.disabled, true);
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
	assert.equal(closed.elements.get("display-mode")?.disabled, true);
	assert.equal(closed.elements.get("connection-state")?.textContent, "OpenDeck disconnected");
	assert.equal(closed.elements.get("error-message")?.textContent, "The connection to OpenDeck was closed.");
});

test("the property inspector rejects oversized startup data before opening a socket", () => {
	const { connect, elements, socket } = loadInspector();
	connect(1234, "pi-context", "registerPropertyInspector", "{}", "x".repeat(64 * 1024 + 1));

	assert.equal(socket(), undefined);
	assert.equal(elements.get("connection-state")?.textContent, "Settings unavailable");
	assert.equal(elements.get("error-message")?.textContent, "OpenDeck sent invalid or oversized action data.");
	assert.equal(elements.get("display-mode")?.disabled, true);
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
	assert.equal(elements.get("connection-detail")?.textContent, "2 Environments · live stream · read only");
	const environment = (label: string, state: string) => ({
		environmentId: label,
		label,
		origin: `http://${label}:3773`,
		expiresAt: "2030-01-01T00:00:00.000Z",
		state,
	});
	connection.emit("message", {
		data: JSON.stringify({
			event: "sendToPropertyInspector",
			payload: {
				status: {
					environments: 3,
					state: "connected",
					connections: [
						environment("anvil", "connected"),
						environment("kiln", "connected"),
						environment("devbox", "offline"),
					],
				},
				type: "connectionStatus",
			},
		}),
	});
	assert.equal(elements.get("connection-state")?.textContent, "Connected");
	assert.equal(
		elements.get("connection-detail")?.textContent,
		"2 of 3 Environments live · not counted: devbox",
	);
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
	assert.equal(elements.get("display-mode")?.disabled, true);

	connection.emit("message", {
		data: JSON.stringify({ event: "didReceiveSettings", payload: { settings: { refreshSeconds: 90 } } }),
	});
	assert.equal(elements.get("display-mode")?.value, "combined");
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
	assert.equal(elements.get("display-mode")?.disabled, true);
});
