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
// A V2 OrchestrationV2ThreadShell, including fields the plugin must ignore.
const thread = (id = "thread-1", extra = {}) => ({
	id,
	projectId: "project-1",
	title: "Private thread title",
	createdBy: "user",
	creationSource: "web",
	interactionMode: "default",
	lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
	latestRunId: "run-1",
	activeRunId: "run-1",
	activeProviderThreadId: "provider-thread-1",
	activityRunStatus: "running",
	status: "running",
	pendingRuntimeRequest: null,
	latestVisibleMessage: {
		id: "message-1",
		role: "assistant",
		text: "Private text",
		updatedAt: "2030-01-01T00:00:00.000Z",
	},
	latestUserMessageAt: null,
	hasActionableProposedPlan: false,
	pendingBackgroundTasks: [],
	itemCount: 3,
	visibleItemCount: 2,
	createdAt: "2030-01-01T00:00:00.000Z",
	updatedAt: "2030-01-01T00:00:00.000Z",
	archivedAt: null,
	settledOverride: null,
	settledAt: null,
	deletedAt: null,
	...extra,
});
const question = {
	pendingRuntimeRequest: { id: "request-1", kind: "user_input", createdAt: "2030-01-01T00:00:00.000Z" },
};

async function fixture(context: TestContext) {
	const requests: Array<{ path: string; authorization?: string; body: string }> = [];
	const subscriptions: Array<Record<string, unknown>> = [];
	const sockets: WebSocket[] = [];
	let rejected = false;
	let environmentId = "env-1";
	let expiresIn = 30 * 86400;
	let grantedScope = "orchestration:read";
	let protocolVersion: number | undefined = 2;
	let capabilities: Record<string, unknown> = { terminal: true };
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
					orchestrationProtocolVersion: protocolVersion,
					capabilities,
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
	};
	ws.on("connection", (socket, request) => {
		const url = new URL(request.url ?? "", "http://localhost");
		assert.equal(url.searchParams.get("wsTicket"), "fixture-ticket");
		assert.equal(url.searchParams.get("orchestrationProtocol"), "2");
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
		setProtocolVersion: (value: number | undefined) => {
			protocolVersion = value;
		},
		setCapabilities: (value: Record<string, unknown>) => {
			capabilities = value;
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
	await until(client, async () => {
		const status = await client.getConnectionStatus();
		return "connections" in status && status.connections.every((env) => env.state === "connected");
	});
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
		{ kind: "thread.updated", sequence: 12, location: "active", thread: thread("thread-1", question) },
	]);
	await until(client, async () => (await client.getSnapshot()).summary.input === 1);
	send(firstSocket(server.sockets), [
		{ kind: "thread.removed", sequence: 13, location: "active", threadId: "thread-1" },
	]);
	await until(client, async () => (await client.getSnapshot()).summary.total === 0);
});

test("metadata refreshes, archive moves, and unknown items keep the active thread set", async (context) => {
	const server = await fixture(context);
	const client = new T3LiveClient({ store: new MemoryStore(), retryMs: 10 });
	context.after(() => client.dispose());
	await client.pair(server.link);
	await connected(client);
	send(firstSocket(server.sockets), [
		{ kind: "synchronized" },
		{
			kind: "snapshot",
			snapshot: { schemaVersion: 1, snapshotSequence: 10, projects: [], threads: [], archivedThreads: [] },
			resolvedRepositoryIdentityRoots: ["/repo"],
		},
		{ kind: "project.updated", sequence: 11, project: { id: "project-1" } },
		{ kind: "future.kind", sequence: 12 },
		{ kind: "thread.updated", sequence: 13, location: "active", thread: thread("thread-2") },
		{ kind: "thread.removed", sequence: 14, location: "archive", threadId: "thread-2" },
	]);
	await until(client, async () => (await client.getSnapshot()).summary.total === 2);
	send(firstSocket(server.sockets), [
		{
			kind: "thread.updated",
			sequence: 15,
			location: "archive",
			thread: thread("thread-2", { archivedAt: "2030-01-01T00:00:00.000Z" }),
		},
	]);
	await until(client, async () => (await client.getSnapshot()).summary.total === 1);
	assert.equal((await client.getConnectionStatus()).state, "connected");
});

test("unsupported orchestration protocols are rejected before credentials are exchanged", async (context) => {
	const server = await fixture(context);
	const client = new T3LiveClient({ store: new MemoryStore(), retryMs: 10 });
	context.after(() => client.dispose());
	server.setProtocolVersion(undefined);
	await assert.rejects(client.pair(server.link), { code: "unsupported-version" });
	assert.equal(server.requests.filter((item) => item.path === "/oauth/token").length, 0);
	server.setProtocolVersion(2);
	await client.pair(server.link);
	await connected(client);
	server.setProtocolVersion(3);
	firstSocket(server.sockets).terminate();
	await until(client, async () => (await client.getConnectionStatus()).state === "offline");
	await assert.rejects(client.getSnapshot(), { code: "unsupported-version" });
});

test("requests trimmed subagent snapshots only from servers that advertise them", async (context) => {
	const server = await fixture(context);
	const client = new T3LiveClient({ store: new MemoryStore(), retryMs: 10 });
	context.after(() => client.dispose());
	server.setCapabilities({ shellThreadFamilies: true });
	await client.pair(server.link);
	await connected(client);
	assert.deepEqual(server.subscriptions[0], { omitIdleSubagents: true });
});

test("reconnect requests a fresh ticket and snapshot before accepting live updates", async (context) => {
	const server = await fixture(context);
	const client = new T3LiveClient({ store: new MemoryStore(), retryMs: 10 });
	context.after(() => client.dispose());
	await client.pair(server.link);
	await connected(client);
	send(firstSocket(server.sockets), [
		{ kind: "thread.updated", sequence: 19, location: "active", thread: thread("thread-1", question) },
	]);
	await until(client, async () => (await client.getSnapshot()).summary.input === 1);
	server.onSubscribe((socket, payload) => {
		assert.deepEqual(payload, {});
		send(socket, [
			{
				kind: "snapshot",
				snapshot: {
					snapshotSequence: 21,
					threads: [thread("thread-2")],
					updatedAt: new Date().toISOString(),
				},
			},
			{ kind: "thread.updated", sequence: 21, location: "active", thread: thread("ignored-duplicate") },
			{ kind: "thread.updated", sequence: 22, location: "active", thread: thread("thread-3") },
		]);
	});
	firstSocket(server.sockets).terminate();
	await until(
		client,
		async () =>
			server.subscriptions.length === 2 && (await client.getConnectionStatus()).state === "connected",
	);
	assert.equal((await client.getSnapshot()).summary.input, 0);
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
	// T3 authorizes at upgrade: an uninterrupted stream can outlive its bearer credential.
	assert.equal((await client.getConnectionStatus()).state, "connected");
	send(firstSocket(server.sockets), [
		{ kind: "thread.updated", sequence: 12, location: "active", thread: thread("thread-1", question) },
	]);
	await until(client, async () => (await client.getSnapshot()).summary.input === 1);
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

test("reconnect waits for a fresh snapshot even when no events changed", async (context) => {
	const server = await fixture(context);
	const client = new T3LiveClient({ store: new MemoryStore(), retryMs: 10 });
	context.after(() => client.dispose());
	await client.pair(server.link);
	await connected(client);
	assert.deepEqual(server.subscriptions[0], {});
	server.onSubscribe((_socket, payload) => {
		assert.deepEqual(payload, {});
	});
	firstSocket(server.sockets).terminate();
	await until(client, async () => server.subscriptions.length === 2);
	assert.equal((await client.getConnectionStatus()).state, "connecting");
	await assert.rejects(client.getSnapshot(), { code: "connecting" });
	const socket = server.sockets[1];
	assert.ok(socket);
	send(socket, [
		{
			kind: "snapshot",
			snapshot: { snapshotSequence: 1000, threads: [], updatedAt: new Date().toISOString() },
		},
	]);
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
	await first.pair(server.link, false, "studio");
	await connected(first);
	await first.dispose();
	const client = new T3LiveClient({ store });
	context.after(() => client.dispose());
	await connected(client);
	const restored = await client.getConnectionStatus();
	assert.equal("connections" in restored && restored.connections[0]?.host, "studio");
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
			host: "studio",
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

test("multiple environments aggregate independently and unreachable environments are left out of the totals", async (context) => {
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
	// A machine that stops answering drops out of the counts; the others keep showing.
	b.setProtocolVersion(3);
	firstSocket(b.sockets).terminate();
	await until(client, async () => {
		const status = await client.getConnectionStatus();
		return "connections" in status && status.connections.some((env) => env.state === "offline");
	});
	assert.equal((await client.getConnectionStatus()).state, "connected");
	assert.equal((await client.getSnapshot()).summary.total, 1);
	// An expired authorization still asks for re-pairing, because only the user can fix it.
	b.setProtocolVersion(2);
	b.setRejected(true);
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
		]);
	});
	send(firstSocket(server.sockets), [
		{ kind: "thread.updated", sequence: 12, location: "active", thread: { id: "bad" } },
	]);
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

test("a saved machine whose plain-HTTP server stops answering moves to its HTTPS address with the same login", async (context) => {
	const server = await fixture(context);
	const store = new MemoryStore();
	const first = new T3LiveClient({ store });
	await first.pair(server.link);
	await connected(first);
	await first.dispose();
	// The saved address now refuses connections, as a server that listens only locally does.
	const saved = store.values[0];
	assert.ok(saved);
	store.values = [{ ...saved, origin: "http://127.0.0.1:1", allowHttp: true }];
	const asked: string[] = [];
	const client = new T3LiveClient({
		store,
		retryMs: 10,
		httpsOrigin: async (hostname) => {
			asked.push(hostname);
			// Stands in for https://<machine>.<tailnet>.ts.net.
			return server.origin;
		},
	});
	context.after(() => client.dispose());
	const count = server.requests.length;
	await connected(client);
	assert.deepEqual(asked, ["127.0.0.1"]);
	const status = await client.getConnectionStatus();
	assert.equal("connections" in status && status.connections[0]?.origin, server.origin);
	assert.equal("connections" in status && status.connections[0]?.host, "127.0.0.1");
	assert.equal((await client.getSnapshot()).summary.total, 1);
	// The login went there only after the same environment answered.
	assert.equal(server.requests[count]?.path, "/.well-known/t3/environment");
	assert.equal(server.requests[count]?.authorization, undefined);
	assert.equal(server.requests.filter((item) => item.path === "/oauth/token").length, 1);
});

test("the HTTPS address is not used when a different environment answers there", async (context) => {
	const server = await fixture(context);
	const store = new MemoryStore();
	const first = new T3LiveClient({ store });
	await first.pair(server.link);
	await first.dispose();
	const saved = store.values[0];
	assert.ok(saved);
	store.values = [{ ...saved, origin: "http://127.0.0.1:1", allowHttp: true, host: "devbox" }];
	server.setIdentity("different");
	const asked: string[] = [];
	const client = new T3LiveClient({
		store,
		retryMs: 10,
		httpsOrigin: async (hostname) => {
			asked.push(hostname);
			return server.origin;
		},
	});
	context.after(() => client.dispose());
	const count = server.requests.length;
	await until(
		client,
		async () => asked.length > 0 && (await client.getConnectionStatus()).state === "offline",
	);
	const status = await client.getConnectionStatus();
	assert.equal(asked[0], "devbox");
	assert.equal("connections" in status && status.connections[0]?.origin, "http://127.0.0.1:1");
	assert.ok(server.requests.slice(count).every((item) => !item.authorization));
});
