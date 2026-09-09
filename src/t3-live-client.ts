import WebSocket from "ws";
import { type ConnectionStore, FileConnectionStore, type SavedConnection } from "./connection-store.js";
import { emptySummary, summarizeSnapshot } from "./status.js";
import type { T3ClientSnapshot } from "./t3-client.js";
import {
	LiveConnectionError,
	type LiveErrorCode,
	MAX_ENVIRONMENTS,
	MAX_RESPONSE_BYTES,
	MAX_THREADS,
	parsePairingLink,
	parseThread,
	record,
	sequence,
	textValue,
} from "./t3-protocol.js";
import type { ConnectionStatus, EnvironmentStatus, T3ThreadShell } from "./types.js";

interface Environment {
	saved: SavedConnection;
	threads: Map<string, T3ThreadShell>;
	sequence?: number;
	state: EnvironmentStatus["state"];
	error?: LiveErrorCode;
	socket?: WebSocket;
	retry?: NodeJS.Timeout;
	heartbeat?: NodeJS.Timeout;
	syncTimeout?: NodeJS.Timeout;
	abort?: AbortController;
	pong: boolean;
	attempt: number;
	generation: number;
}
export interface LiveClientOptions {
	store?: ConnectionStore;
	fetchImpl?: typeof fetch;
	now?: () => number;
	retryMs?: number;
	heartbeatMs?: number;
}

export class T3LiveClient {
	private readonly store: ConnectionStore;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly listeners = new Set<() => void>();
	private readonly environments = new Map<string, Environment>();
	private readonly ready: Promise<void>;
	private readonly clockTimer: NodeJS.Timeout;
	private disposed = false;
	private busy = false;
	private loadError?: LiveErrorCode;
	private notificationTimer?: NodeJS.Timeout;

	constructor(private readonly options: LiveClientOptions = {}) {
		this.store = options.store ?? new FileConnectionStore();
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? Date.now;
		this.ready = this.restore();
		// Re-evaluate time-based snoozes/settlement locally; this makes no HTTP requests.
		this.clockTimer = setInterval(() => this.emit(), 30_000);
		this.clockTimer.unref();
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private emit(): void {
		if (this.disposed || this.notificationTimer) return;
		// Bound inspector traffic and rendering during a burst of shell events.
		this.notificationTimer = setTimeout(() => {
			this.notificationTimer = undefined;
			if (!this.disposed) for (const listener of this.listeners) listener();
		}, 50);
		this.notificationTimer.unref();
	}
	private async restore(): Promise<void> {
		try {
			const saved = await this.store.load();
			if (this.disposed) return;
			for (const connection of saved) this.install(connection);
		} catch {
			this.loadError = "storage-error";
		}
		this.emit();
	}
	private install(saved: SavedConnection): void {
		const old = this.environments.get(saved.environmentId);
		if (old) this.stop(old);
		const env: Environment = {
			saved,
			threads: new Map(),
			state: "connecting",
			pong: true,
			attempt: 0,
			generation: 0,
		};
		this.environments.set(saved.environmentId, env);
		void this.connect(env);
	}
	async pair(link: string, allowHttp = false): Promise<void> {
		await this.ready;
		if (this.busy) throw new LiveConnectionError("busy");
		if (this.disposed) return;
		if (this.loadError) throw new LiveConnectionError(this.loadError);
		this.busy = true;
		try {
			const target = parsePairingLink(link, allowHttp);
			const descriptor = await this.request(target.origin, "/.well-known/t3/environment");
			if (!record(descriptor) || !textValue(descriptor.environmentId))
				throw new LiveConnectionError("invalid-response");
			if (!this.environments.has(descriptor.environmentId) && this.environments.size >= MAX_ENVIRONMENTS)
				throw new LiveConnectionError("invalid-response");
			const response = await this.request(target.origin, "/oauth/token", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
					subject_token: target.credential,
					subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
					requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
					scope: "orchestration:read",
					client_label: "OpenDeck T3 Code Status",
				}),
			});
			if (
				!record(response) ||
				!textValue(response.access_token, 8192) ||
				response.token_type !== "Bearer" ||
				response.scope !== "orchestration:read" ||
				typeof response.expires_in !== "number" ||
				!Number.isFinite(response.expires_in) ||
				response.expires_in <= 0 ||
				response.expires_in > 366 * 86400
			)
				throw new LiveConnectionError("invalid-response");
			const saved: SavedConnection = {
				environmentId: descriptor.environmentId,
				label: textValue(descriptor.label, 120) ? descriptor.label : new URL(target.origin).host,
				origin: target.origin,
				token: response.access_token,
				expiresAt: this.now() + response.expires_in * 1000,
				allowHttp,
			};
			const session = await this.request(target.origin, "/api/auth/session", {
				headers: { authorization: `Bearer ${saved.token}` },
			});
			if (
				!record(session) ||
				session.authenticated !== true ||
				!Array.isArray(session.scopes) ||
				session.scopes.length !== 1 ||
				session.scopes[0] !== "orchestration:read"
			)
				throw new LiveConnectionError("authorization-required");
			if (this.disposed) return;
			await this.store.save(
				[...this.environments.values()]
					.filter((env) => env.saved.environmentId !== saved.environmentId)
					.map((env) => env.saved)
					.concat(saved),
			);
			if (!this.disposed) this.install(saved);
		} finally {
			this.busy = false;
			this.emit();
		}
	}
	async remove(environmentId: string): Promise<void> {
		await this.ready;
		if (this.busy) throw new LiveConnectionError("busy");
		const env = this.environments.get(environmentId);
		if (!env || this.disposed) return;
		this.busy = true;
		try {
			await this.store.save(
				[...this.environments.values()].filter((item) => item !== env).map((item) => item.saved),
			);
			this.stop(env);
			this.environments.delete(environmentId);
		} finally {
			this.busy = false;
			this.emit();
		}
	}
	async reconnect(): Promise<void> {
		await this.ready;
		for (const env of this.environments.values()) {
			if (env.state === "connected" || env.state === "connecting" || env.state === "authorization-required")
				continue;
			this.stop(env);
			void this.connect(env);
		}
	}
	async getConnectionStatus(): Promise<ConnectionStatus> {
		await this.ready;
		const connections: EnvironmentStatus[] = [...this.environments.values()].map((env) => ({
			environmentId: env.saved.environmentId,
			label: env.saved.label,
			origin: env.saved.origin,
			expiresAt: env.saved.expiresAt,
			state: env.state,
			...(env.error ? { error: env.error } : {}),
		}));
		const state = this.loadError
			? "error"
			: connections.length === 0
				? "pairing-required"
				: connections.some((env) => env.state === "authorization-required")
					? "authorization-required"
					: connections.every((env) => env.state === "connected")
						? "connected"
						: connections.some((env) => env.state === "connecting")
							? "connecting"
							: "offline";
		return {
			state,
			origin: connections[0]?.origin ?? "",
			environments: connections.length,
			connections,
			...(this.loadError ? { error: this.loadError } : {}),
		};
	}
	async getSnapshot(): Promise<T3ClientSnapshot> {
		const connectionStatus = await this.getConnectionStatus();
		if (connectionStatus.state !== "connected")
			throw new LiveConnectionError(
				connectionStatus.state === "error" ? (this.loadError ?? "invalid-response") : connectionStatus.state,
			);
		const summary = emptySummary();
		for (const env of this.environments.values()) {
			const part = summarizeSnapshot(
				{
					snapshotSequence: env.sequence ?? 0,
					threads: [...env.threads.values()],
					updatedAt: new Date(this.now()).toISOString(),
				},
				this.now(),
			);
			for (const key of Object.keys(summary) as Array<keyof typeof summary>) summary[key] += part[key];
		}
		return { connectionStatus, summary };
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		clearInterval(this.clockTimer);
		clearTimeout(this.notificationTimer);
		for (const env of this.environments.values()) this.stop(env);
		this.listeners.clear();
		await this.ready;
	}
	private stop(env: Environment): void {
		env.generation++;
		env.abort?.abort();
		env.abort = undefined;
		clearTimeout(env.retry);
		clearTimeout(env.syncTimeout);
		clearInterval(env.heartbeat);
		env.retry = undefined;
		env.heartbeat = undefined;
		env.syncTimeout = undefined;
		const socket = env.socket;
		env.socket = undefined;
		socket?.terminate();
	}
	private fail(env: Environment, code: LiveErrorCode): void {
		this.stop(env);
		if (this.disposed) return;
		env.error = code;
		env.state = code === "authorization-required" ? "authorization-required" : "offline";
		if (code !== "authorization-required" && code !== "identity-mismatch") {
			const delay = Math.min(30_000, (this.options.retryMs ?? 1000) * 2 ** Math.min(env.attempt++, 5));
			env.retry = setTimeout(() => {
				env.retry = undefined;
				void this.connect(env);
			}, delay);
			env.retry.unref();
		}
		this.emit();
	}
	private async connect(env: Environment): Promise<void> {
		if (this.disposed) return;
		if (this.now() >= env.saved.expiresAt) {
			this.fail(env, "authorization-required");
			return;
		}
		const generation = ++env.generation;
		const current = () => !this.disposed && generation === env.generation;
		env.state = "connecting";
		env.error = undefined;
		env.abort = new AbortController();
		this.emit();
		try {
			const descriptor = await this.request(
				env.saved.origin,
				"/.well-known/t3/environment",
				{},
				env.abort.signal,
			);
			if (!current()) return;
			if (!record(descriptor) || descriptor.environmentId !== env.saved.environmentId)
				throw new LiveConnectionError("identity-mismatch");
			const ticket = await this.request(
				env.saved.origin,
				"/api/auth/websocket-ticket",
				{ method: "POST", headers: { authorization: `Bearer ${env.saved.token}` } },
				env.abort.signal,
			);
			if (!current()) return;
			if (!record(ticket) || !textValue(ticket.ticket, 8192))
				throw new LiveConnectionError("invalid-response");
			const url = new URL("/ws", env.saved.origin);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.searchParams.set("wsTicket", ticket.ticket);
			const socket = new WebSocket(url, {
				handshakeTimeout: 10_000,
				maxPayload: MAX_RESPONSE_BYTES,
				followRedirects: false,
			});
			env.socket = socket;
			socket.on("error", () => {
				/* Never log socket URLs or server responses. */
			});
			socket.on("unexpected-response", (_request, response) => {
				response.destroy();
				if (current())
					this.fail(
						env,
						response.statusCode === 401 || response.statusCode === 403 ? "authorization-required" : "offline",
					);
			});
			socket.on("close", () => {
				if (current()) this.fail(env, "offline");
			});
			socket.on("open", () => {
				if (!current()) {
					socket.terminate();
					return;
				}
				// A fresh snapshot on every connection avoids depending on optional replay markers.
				env.sequence = undefined;
				env.threads.clear();
				socket.send(
					JSON.stringify({
						_tag: "Request",
						id: "shell",
						tag: "orchestration.subscribeShell",
						payload: {},
						headers: [],
					}),
				);
				env.syncTimeout = setTimeout(() => {
					if (current()) this.fail(env, "offline");
				}, 15_000);
				env.syncTimeout.unref();
				env.pong = true;
				env.heartbeat = setInterval(() => {
					if (!env.pong) {
						if (current()) this.fail(env, "offline");
						return;
					}
					env.pong = false;
					if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ _tag: "Ping" }));
				}, this.options.heartbeatMs ?? 30_000);
				env.heartbeat.unref();
			});
			socket.on("message", (data) => {
				if (!current()) return;
				try {
					const value: unknown = JSON.parse(data.toString());
					const messages = Array.isArray(value) ? value : [value];
					if (messages.length > 10_000) throw new Error();
					for (const message of messages) {
						if (!record(message)) throw new Error();
						if (message._tag === "Pong") {
							env.pong = true;
							continue;
						}
						if (message._tag !== "Chunk" || message.requestId !== "shell" || !Array.isArray(message.values))
							throw new Error();
						for (const item of message.values) this.apply(env, item);
						if (socket.readyState === WebSocket.OPEN)
							socket.send(JSON.stringify({ _tag: "Ack", requestId: "shell" }));
					}
					if (env.state === "connected") this.emit();
				} catch {
					env.sequence = undefined;
					env.threads.clear();
					this.fail(env, "invalid-response");
				}
			});
		} catch (error) {
			if (current()) this.fail(env, error instanceof LiveConnectionError ? error.code : "offline");
		}
	}
	private apply(env: Environment, item: unknown): void {
		if (!record(item)) throw new Error();
		if (item.kind === "snapshot") {
			const snapshot = item.snapshot;
			if (
				!record(snapshot) ||
				!sequence(snapshot.snapshotSequence) ||
				!Array.isArray(snapshot.threads) ||
				snapshot.threads.length > MAX_THREADS
			)
				throw new Error();
			const threads = new Map<string, T3ThreadShell>();
			for (const raw of snapshot.threads) {
				const thread = parseThread(raw);
				if (threads.has(thread.id)) throw new Error();
				threads.set(thread.id, thread);
			}
			env.threads = threads;
			env.sequence = snapshot.snapshotSequence;
			this.synchronized(env);
			return;
		}
		if (!sequence(item.sequence) || env.sequence === undefined) throw new Error();
		if (item.sequence <= env.sequence) return;
		switch (item.kind) {
			case "thread-upserted": {
				const thread = parseThread(item.thread);
				if (!env.threads.has(thread.id) && env.threads.size >= MAX_THREADS) throw new Error();
				env.threads.set(thread.id, thread);
				break;
			}
			case "thread-removed":
				if (!textValue(item.threadId)) throw new Error();
				env.threads.delete(item.threadId);
				break;
			case "project-upserted":
			case "project-removed":
				break;
			default:
				throw new Error();
		}
		env.sequence = item.sequence;
	}
	private synchronized(env: Environment): void {
		env.state = "connected";
		env.error = undefined;
		env.attempt = 0;
		clearTimeout(env.syncTimeout);
		env.syncTimeout = undefined;
	}
	private async request(
		origin: string,
		path: string,
		init: RequestInit = {},
		signal?: AbortSignal,
	): Promise<unknown> {
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) controller.abort();
		const timeout = setTimeout(abort, 10_000);
		try {
			const response = await this.fetchImpl(new URL(path, origin), {
				...init,
				redirect: "error",
				signal: controller.signal,
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new LiveConnectionError(
					response.status === 401 || response.status === 403 ? "authorization-required" : "offline",
				);
			}
			if (!response.body) throw new LiveConnectionError("invalid-response");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let length = 0;
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					length += next.value.byteLength;
					if (length > 128 * 1024) throw new LiveConnectionError("invalid-response");
					chunks.push(next.value);
				}
			} finally {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
			try {
				return JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				throw new LiveConnectionError("invalid-response");
			}
		} catch (error) {
			throw error instanceof LiveConnectionError ? error : new LiveConnectionError("offline");
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		}
	}
}
