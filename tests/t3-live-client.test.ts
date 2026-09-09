import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type WebSocket, WebSocketServer } from "ws";
import { type ConnectionStore, FileConnectionStore, type SavedConnection } from "../src/connection-store.js";
import { T3LiveClient } from "../src/t3-live-client.js";
import { parsePairingLink } from "../src/t3-protocol.js";

class MemoryStore implements ConnectionStore {
	values: SavedConnection[] = [];
	async load() {
		return structuredClone(this.values);
	}
	async save(values: SavedConnection[]) {
		this.values = structuredClone(values);
	}
}
const thread = (id = "thread-1", extra = {}) => ({
	id,
	interactionMode: "default",
	archivedAt: null,
	settledOverride: "active",
	settledAt: null,
	hasPendingApprovals: false,
	hasPendingUserInput: false,
	hasActionableProposedPlan: false,
	latestTurn: null,
	session: { status: "running" },
	...extra,
});

async function fixture(context: TestContext, marker = true) {
	const requests: Array<{ path: string; authorization?: string; body: string }> = [];
	const subscriptions: Array<Record<string, unknown>> = [];
	const sockets: WebSocket[] = [];
	let rejected = false;
	let environmentId = "env-1";
	let expiresIn = 30 * 86400;
	let grantedScope = "orchestration:read";
	let descriptorCapability = marker;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
		response.setHeader("content-type", "application/json");
		if (request.url === "/.well-known/t3/environment")
			response.end(
				JSON.stringify({
					environmentId,
					label: "Test environment",
					capabilities: { shellResumeCompletionMarker: descriptorCapability },
				}),
			);
		else if (rejected) {
			response.statusCode = 401;
			response.end("{}");
		} else if (request.url === "/oauth/token")
			response.end(
				JSON.stringify({
					access_token: "fixture-bearer",
					token_type: "Bearer",
					scope: grantedScope,
					expires_in: expiresIn,
				}),
			);
		else if (request.url === "/api/auth/session")
			response.end(JSON.stringify({ authenticated: true, scopes: [grantedScope] }));
		else if (request.url === "/api/auth/websocket-ticket")
			response.end(JSON.stringify({ ticket: "fixture-ticket" }));
		else {
			response.statusCode = 404;
			response.end("{}");
		}
	});
	const ws = new WebSocketServer({ server });
	let onSubscribe = (socket: WebSocket, payload: Record<string, unknown>) => {
		if (payload.afterSequence === undefined)
			send(socket, [
				{
					kind: "snapshot",
					snapshot: { snapshotSequence: 10, threads: [thread()], updatedAt: new Date().toISOString() },
				},
			]);
		if (descriptorCapability) send(socket, [{ kind: "synchronized" }]);
	};
	ws.on("connection", (socket, request) => {
		assert.equal(
			new URL(request.url ?? "", "http://localhost").searchParams.get("wsTicket"),
			"fixture-ticket",
		);
		assert.equal(request.headers.authorization, undefined);
		sockets.push(socket);
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
			if (message._tag === "Request") {
				assert.equal(message.tag, "orchestration.subscribeShell");
				subscriptions.push(message.payload);
				onSubscribe(socket, message.payload);
			}
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	context.after(async () => {
		for (const socket of ws.clients) socket.terminate();
		ws.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return {
		origin,
		link: `${origin}/pair#token=fixture-pairing`,
		requests,
		subscriptions,
		sockets,
		setRejected: (value: boolean) => {
			rejected = value;
		},
		setIdentity: (value: string) => {
			environmentId = value;
		},
		setExpiry: (value: number) => {
			expiresIn = value;
		},
		setScope: (value: string) => {
			grantedScope = value;
		},
		setMarker: (value: boolean) => {
			descriptorCapability = value;
		},
		onSubscribe: (callback: typeof onSubscribe) => {
			onSubscribe = callback;
		},
	};
}
function send(socket: WebSocket, values: unknown[]) {
	socket.send(JSON.stringify({ _tag: "Chunk", requestId: "shell", values }));
}
async function until(client: T3LiveClient, predicate: () => Promise<boolean>) {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("Expected live state was not reached"));
		}, 2000);
		const check = () => {
			void predicate().then((ok) => {
				if (ok) {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			}, reject);
		};
		const unsubscribe = client.subscribe(check);
		check();
	});
}
async function connected(client: T3LiveClient) {
	await until(client, async () => (await client.getConnectionStatus()).state === "connected");
}

test("pairing exchanges only read scope, streams input changes and removals without polling", async (context) => {
	const server = await fixture(context);
	const store = new MemoryStore();
	const client = new T3LiveClient({ store, retryMs: 10 });
	context.after(() => client.dispose());
	assert.equal((await client.getConnectionStatus()).state, "pairing-required");
	await client.pair(server.link);
	await connected(client);
	assert.equal((await client.getSnapshot()).summary.running, 1);
	const exchange = server.requests.find((item) => item.path === "/oauth/token");
	assert.ok(exchange);
	assert.equal(new URLSearchParams(exchange.body).get("scope"), "orchestration:read");
	assert.equal(new URLSearchParams(exchange.body).get("subject_token"), "fixture-pairing");
	assert.equal(store.values.length, 1);
	assert.doesNotMatch(JSON.stringify(await client.getConnectionStatus()), /fixture-bearer|fixture-pairing/);
	const count = server.requests.length;
	await Promise.all(Array.from({ length: 20 }, () => client.getSnapshot()));
	assert.equal(server.requests.length, count);
	send(firstSocket(server.sockets), [
		{ kind: "thread-upserted", sequence: 12, thread: thread("thread-1", { hasPendingUserInput: true }) },
	]);
	await until(client, async () => (await client.getSnapshot()).summary.input === 1);
	send(firstSocket(server.sockets), [{ kind: "thread-removed", sequence: 13, threadId: "thread-1" }]);
	await until(client, async () => (await client.getSnapshot()).summary.total === 0);
});

test("reconnect requests a fresh ticket and resumes after the last applied sequence", async (context) => {
	const server = await fixture(context);
	const client = new T3LiveClient({ store: new MemoryStore(), retryMs: 10 });
	context.after(() => client.dispose());
	await client.pair(server.link);
	await connected(client);
	send(firstSocket(server.sockets), [
		{ kind: "thread-upserted", sequence: 19, thread: thread("thread-1", { hasPendingUserInput: true }) },
	]);
	await until(client, async () => (await client.getSnapshot()).summary.input === 1);
	server.onSubscribe((socket, payload) => {
		assert.equal(payload.afterSequence, 19);
		send(socket, [
			{ kind: "thread-upserted", sequence: 19, thread: thread() },
			{ kind: "thread-upserted", sequence: 21, thread: thread("thread-2") },
			{ kind: "synchronized" },
		]);
	});
	firstSocket(server.sockets).terminate();
	await until(
		client,
		async () =>
			server.subscriptions.length === 2 && (await client.getConnectionStatus()).state === "connected",
	);
	assert.equal((await client.getSnapshot()).summary.input, 1);
	assert.equal((await client.getSnapshot()).summary.total, 2);
	assert.equal(server.requests.filter((item) => item.path === "/oauth/token").length, 1);
	assert.equal(server.requests.filter((item) => item.path === "/api/auth/websocket-ticket").length, 2);
});

test("expired sessions stop automatic retries; re-pair replaces credentials without duplicating environments", async (context) => {
	const server = await fixture(context);
	const store = new MemoryStore();
	let now = Date.now();
	const client = new T3LiveClient({ store, now: () => now, retryMs: 10 });
	context.after(() => client.dispose());
	await client.pair(server.link);
	await connected(client);
	now += 31 * 86400_000;
	firstSocket(server.sockets).terminate();
	await until(client, async () => (await client.getConnectionStatus()).state === "authorization-required");
	await assert.rejects(client.getSnapshot(), { code: "authorization-required" });
	const requestCount = server.requests.length;
	await client.reconnect();
	assert.equal(server.requests.length, requestCount);
	await client.pair(server.link);
	await connected(client);
	assert.equal(store.values.length, 1);
	assert.equal((await client.getSnapshot()).summary.running, 1);
	await client.remove("env-1");
	assert.equal(store.values.length, 0);
	assert.equal((await client.getConnectionStatus()).state, "pairing-required");
});

test("old servers receive no resume options; replacement snapshots recover from stale cursors", async (context) => {
	const server = await fixture(context, false);
	const client = new T3LiveClient({ store: new MemoryStore(), retryMs: 10 });
	context.after(() => client.dispose());
	await client.pair(server.link);
	await connected(client);
	assert.deepEqual(server.subscriptions[0], {});
	server.setMarker(true);
	server.onSubscribe((socket, payload) => {
		assert.equal(payload.afterSequence, 10);
		send(socket, [
			{
				kind: "snapshot",
				snapshot: { snapshotSequence: 1000, threads: [], updatedAt: new Date().toISOString() },
			},
			{ kind: "synchronized" },
		]);
	});
	firstSocket(server.sockets).terminate();
	await until(
		client,
		async () =>
			server.subscriptions.length === 2 && (await client.getConnectionStatus()).state === "connected",
	);
	assert.equal((await client.getSnapshot()).summary.total, 0);
});

test("identity mismatch never sends bearer credentials and revoked sessions require pairing", async (context) => {
	const server = await fixture(context);
	const store = new MemoryStore();
	const client = new T3LiveClient({ store, retryMs: 10 });
	context.after(() => client.dispose());
	await client.pair(server.link);
	await connected(client);
	const count = server.requests.length;
	server.setIdentity("different");
	firstSocket(server.sockets).terminate();
	await until(client, async () => {
		const status = await client.getConnectionStatus();
		return "connections" in status && status.connections[0]?.error === "identity-mismatch";
	});
	assert.ok(server.requests.slice(count).every((item) => !item.authorization));
	server.setIdentity("env-1");
	server.setRejected(true);
	await client.reconnect();
	await until(client, async () => (await client.getConnectionStatus()).state === "authorization-required");
});

test("restore credentials across plugin restarts and reject excessive scopes without replacing existing connection", async (context) => {
	const server = await fixture(context);
	const store = new MemoryStore();
	const first = new T3LiveClient({ store });
	await first.pair(server.link);
	await connected(first);
	await first.dispose();
	const client = new T3LiveClient({ store });
	context.after(() => client.dispose());
	await connected(client);
	assert.equal(server.requests.filter((item) => item.path === "/oauth/token").length, 1);
	server.setScope("orchestration:read orchestration:operate");
	await assert.rejects(client.pair(server.link), { code: "invalid-response" });
	assert.equal((await client.getConnectionStatus()).state, "connected");
	assert.equal(store.values.length, 1);
});

test("pairing links support hosted links, reject credentials in authority, and require opt-in for LAN HTTP", () => {
	assert.deepEqual(
		parsePairingLink("https://app.t3.codes/pair?host=https%3A%2F%2Fhost.example#token=fixture"),
		{ origin: "https://host.example", credential: "fixture" },
	);
	assert.throws(() => parsePairingLink("http://192.168.1.2/pair#token=fixture"), { code: "insecure-origin" });
	assert.equal(parsePairingLink("http://192.168.1.2/pair#token=fixture", true).origin, "http://192.168.1.2");
	for (const link of [
		"oops",
		"https://user:pass@example.com/pair#token=fixture",
		"file:///tmp/test#token=fixture",
		"https://example.com/pair",
	])
		assert.throws(() => parsePairingLink(link), { code: "invalid-link" });
});

test("credentials persist with private permissions, and corrupt stores fail closed", async (context) => {
	const folder = await mkdtemp(join(tmpdir(), "opendeck-stream-store-"));
	context.after(() => rm(folder, { recursive: true, force: true }));
	const path = join(folder, "private", "connections.json");
	const store = new FileConnectionStore(path);
	assert.deepEqual(await store.load(), []);
	const values: SavedConnection[] = [
		{
			environmentId: "env",
			label: "Test",
			origin: "http://127.0.0.1:3773",
			token: "fixture",
			expiresAt: Date.now() + 1000,
			allowHttp: false,
		},
	];
	await store.save(values);
	assert.deepEqual(await store.load(), values);
	assert.ok((await readFile(path, "utf8")).includes("fixture"));
	if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
	await store.save([...values, ...values]);
	await assert.rejects(store.load(), { code: "storage-error" });
});

function firstSocket(sockets: WebSocket[]): WebSocket {
	const socket = sockets[0];
	assert.ok(socket);
	return socket;
}

test("multiple environments aggregate independently and offline environments never produce partial live totals", async (context) => {
	const a = await fixture(context);
	const b = await fixture(context);
	b.setIdentity("env-2");
	const store = new MemoryStore();
	const client = new T3LiveClient({ store, retryMs: 10 });
	context.after(() => client.dispose());
	await client.pair(a.link);
	await connected(client);
	await client.pair(b.link);
	await connected(client);
	assert.equal((await client.getSnapshot()).summary.total, 2);
	assert.equal(a.subscriptions.length, 1);
	assert.equal(b.subscriptions.length, 1);
	b.setRejected(true);
	firstSocket(b.sockets).terminate();
	await until(client, async () => (await client.getConnectionStatus()).state === "authorization-required");
	await assert.rejects(client.getSnapshot(), { code: "authorization-required" });
	await client.remove("env-2");
	await connected(client);
	assert.equal((await client.getSnapshot()).summary.total, 1);
	assert.equal(a.subscriptions.length, 1);
});

test("malformed stream data drops stale state and reconnects with a complete snapshot", async (context) => {
	const server = await fixture(context);
	const client = new T3LiveClient({ store: new MemoryStore(), retryMs: 10 });
	context.after(() => client.dispose());
	await client.pair(server.link);
	await connected(client);
	server.onSubscribe((socket, payload) => {
		assert.equal(payload.afterSequence, undefined);
		send(socket, [
			{
				kind: "snapshot",
				snapshot: { snapshotSequence: 22, threads: [], updatedAt: new Date().toISOString() },
			},
			{ kind: "synchronized" },
		]);
	});
	send(firstSocket(server.sockets), [{ kind: "thread-upserted", sequence: 12, thread: { id: "bad" } }]);
	await until(
		client,
		async () =>
			server.subscriptions.length === 2 && (await client.getConnectionStatus()).state === "connected",
	);
	assert.equal((await client.getSnapshot()).summary.total, 0);
});

test("HTTP redirects are refused before credentials are sent to another origin", async (context) => {
	const server = createServer((_request, response) => {
		response.writeHead(302, { location: "http://127.0.0.1:1/secret-destination" });
		response.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const store = new MemoryStore();
	const client = new T3LiveClient({ store });
	context.after(() => client.dispose());
	await assert.rejects(client.pair(`http://127.0.0.1:${address.port}/pair#token=fixture`), {
		code: "offline",
	});
	assert.equal(store.values.length, 0);
});
