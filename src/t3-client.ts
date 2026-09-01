import { type BigIntStats, constants as fileConstants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { summarizeSnapshot } from "./status.js";
import {
	type CachedT3Shell,
	type ReadT3ShellCacheOptions,
	readT3ShellCache,
	sameFileIdentity,
	T3CacheError,
} from "./t3-cache.js";
import type { ConnectionStatus, T3ShellSnapshot, ThreadSummary } from "./types.js";

const DEFAULT_AUTO_SETTLE_AFTER_DAYS = 3;
const MIN_AUTO_SETTLE_AFTER_DAYS = 1;
const MAX_AUTO_SETTLE_AFTER_DAYS = 90;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RUNTIME_FILE_BYTES = 16 * 1024;
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;
const MAX_ENVIRONMENT_RESPONSE_BYTES = 64 * 1024;
const READ_ONLY_FILE_FLAGS =
	process.platform === "win32"
		? fileConstants.O_RDONLY
		: fileConstants.O_RDONLY | fileConstants.O_NONBLOCK | fileConstants.O_NOFOLLOW;

export type T3ClientErrorCode =
	| "offline"
	| "unsafe-origin"
	| "invalid-response"
	| "cache-unavailable"
	| "cache-read-failed";

export class T3ClientError extends Error {
	constructor(readonly code: T3ClientErrorCode) {
		super(code);
		this.name = "T3ClientError";
	}
}

interface RuntimeDescriptor {
	origin: string;
}

interface EnvironmentDescriptor {
	environmentId: string;
}

type ReadShellCache = (options?: ReadT3ShellCacheOptions) => Promise<CachedT3Shell[]>;

export interface T3ClientOptions {
	cacheDirectory?: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
	readShellCache?: ReadShellCache;
	runtimeFile?: string;
	settingsFile?: string;
}

export interface T3ClientSnapshot {
	connectionStatus: ConnectionStatus;
	summary: ThreadSummary;
}

export class T3Client {
	private readonly cacheDirectory: string | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly readShellCache: ReadShellCache;
	private readonly runtimeFile: string;
	private readonly settingsFile: string;

	constructor(options: T3ClientOptions = {}) {
		const t3Home = process.env.T3CODE_HOME?.trim() || resolve(homedir(), ".t3");
		this.cacheDirectory = options.cacheDirectory;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? Date.now;
		this.readShellCache = options.readShellCache ?? readT3ShellCache;
		this.runtimeFile = options.runtimeFile ?? resolve(t3Home, "userdata", "server-runtime.json");
		this.settingsFile = options.settingsFile ?? resolve(t3Home, "userdata", "client-settings.json");
	}

	async getSummary(): Promise<ThreadSummary> {
		return (await this.getSnapshot()).summary;
	}

	async getSnapshot(): Promise<T3ClientSnapshot> {
		const origin = await this.discoverOrigin();
		const environment = await this.readEnvironmentDescriptor(origin);
		const [shells, autoSettleAfterDays] = await Promise.all([
			this.readCachedShells(environment.environmentId),
			this.readAutoSettleAfterDays(),
		]);
		return {
			connectionStatus: { state: "connected", origin, environments: shells.length },
			summary: summarizeShells(shells, this.now(), autoSettleAfterDays),
		};
	}

	async getConnectionStatus(): Promise<ConnectionStatus> {
		let origin: string | undefined;
		try {
			origin = await this.discoverOrigin();
			const environment = await this.readEnvironmentDescriptor(origin);
			const shells = await this.readCachedShells(environment.environmentId);
			return { state: "connected", origin, environments: shells.length };
		} catch (error) {
			if (error instanceof T3ClientError && error.code === "offline") {
				return { state: "offline", ...(origin ? { origin } : {}) };
			}
			throw error;
		}
	}

	private async discoverOrigin(): Promise<string> {
		let raw: string;
		try {
			raw = await readBoundedTextFile(this.runtimeFile, MAX_RUNTIME_FILE_BYTES);
		} catch (error) {
			if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
				throw new T3ClientError("offline");
			}
			throw new T3ClientError("invalid-response");
		}

		let runtime: RuntimeDescriptor;
		try {
			runtime = JSON.parse(raw) as RuntimeDescriptor;
		} catch {
			throw new T3ClientError("invalid-response");
		}
		return normalizeLocalOrigin(runtime.origin);
	}

	private async readEnvironmentDescriptor(origin: string): Promise<EnvironmentDescriptor> {
		let response: Response;
		try {
			response = await this.fetchImpl(new URL("/.well-known/t3/environment", origin), {
				redirect: "error",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new T3ClientError("offline");
		}
		if (!response.ok) throw new T3ClientError("offline");

		let raw: string;
		try {
			raw = await readBoundedResponseText(response, MAX_ENVIRONMENT_RESPONSE_BYTES);
		} catch {
			throw new T3ClientError("invalid-response");
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new T3ClientError("invalid-response");
		}
		return parseEnvironmentDescriptor(value);
	}

	private async readCachedShells(environmentId: string): Promise<CachedT3Shell[]> {
		try {
			return await this.readShellCache({
				...(this.cacheDirectory === undefined ? {} : { directory: this.cacheDirectory }),
				environmentId,
			});
		} catch (error) {
			if (error instanceof T3CacheError && error.code === "unavailable") {
				throw new T3ClientError("cache-unavailable");
			}
			throw new T3ClientError("cache-read-failed");
		}
	}

	private async readAutoSettleAfterDays(): Promise<number | null> {
		let raw: string;
		try {
			raw = await readBoundedTextFile(this.settingsFile, MAX_SETTINGS_FILE_BYTES);
		} catch (error) {
			if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
				return DEFAULT_AUTO_SETTLE_AFTER_DAYS;
			}
			throw new T3ClientError("invalid-response");
		}

		let settings: unknown;
		try {
			settings = JSON.parse(raw);
		} catch {
			throw new T3ClientError("invalid-response");
		}
		const clientSettings = isRecord(settings) && isRecord(settings.settings) ? settings.settings : settings;
		if (!isRecord(clientSettings) || !("sidebarAutoSettleAfterDays" in clientSettings)) {
			return DEFAULT_AUTO_SETTLE_AFTER_DAYS;
		}
		const value = clientSettings.sidebarAutoSettleAfterDays;
		if (value === null) return null;
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			value < MIN_AUTO_SETTLE_AFTER_DAYS ||
			value > MAX_AUTO_SETTLE_AFTER_DAYS
		) {
			throw new T3ClientError("invalid-response");
		}
		return value;
	}
}

async function readBoundedTextFile(path: string, maxBytes: number): Promise<string> {
	const { handle, metadata } = await openStableRegularFile(path);
	try {
		if (metadata.size > BigInt(maxBytes)) throw new Error("invalid-response");
		const size = Number(metadata.size);
		const contents = Buffer.allocUnsafe(size);
		let offset = 0;
		while (offset < size) {
			const { bytesRead } = await handle.read(contents, offset, size - offset, offset);
			if (bytesRead === 0) throw new Error("invalid-response");
			offset += bytesRead;
		}
		const extra = Buffer.allocUnsafe(1);
		if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) throw new Error("invalid-response");
		await assertFileUnchanged(handle, metadata);
		return contents.toString("utf8");
	} finally {
		await handle.close();
	}
}

async function openStableRegularFile(path: string): Promise<{ handle: FileHandle; metadata: BigIntStats }> {
	const before = await lstat(path, { bigint: true });
	if (!before.isFile()) throw new Error("invalid-response");
	const handle = await open(path, READ_ONLY_FILE_FLAGS);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || !sameFileIdentity(before, opened)) throw new Error("invalid-response");
		return { handle, metadata: opened };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function assertFileUnchanged(handle: FileHandle, before: BigIntStats): Promise<void> {
	const after = await handle.stat({ bigint: true });
	if (
		!after.isFile() ||
		!sameFileIdentity(before, after) ||
		after.size !== before.size ||
		after.mtimeNs !== before.mtimeNs ||
		after.ctimeNs !== before.ctimeNs
	) {
		throw new Error("invalid-response");
	}
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const declaredBytes = Number(contentLength);
		if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes) {
			throw new Error("invalid-response");
		}
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const contents = Buffer.allocUnsafe(maxBytes);
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			if (value.byteLength > maxBytes - totalBytes) throw new Error("invalid-response");
			contents.set(value, totalBytes);
			totalBytes += value.byteLength;
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	return contents.subarray(0, totalBytes).toString("utf8");
}

export function summarizeShells(
	shells: readonly CachedT3Shell[],
	now = Date.now(),
	autoSettleAfterDays: number | null = DEFAULT_AUTO_SETTLE_AFTER_DAYS,
): ThreadSummary {
	const snapshot: T3ShellSnapshot = {
		snapshotSequence: 0,
		threads: shells.flatMap(({ snapshot: cachedSnapshot }) => cachedSnapshot.threads),
		updatedAt: new Date(0).toISOString(),
	};
	return summarizeSnapshot(snapshot, now, autoSettleAfterDays);
}

function normalizeLocalOrigin(value: unknown): string {
	if (typeof value !== "string") throw new T3ClientError("invalid-response");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new T3ClientError("invalid-response");
	}
	const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
	if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
		throw new T3ClientError("unsafe-origin");
	}
	url.pathname = "/";
	url.search = "";
	url.hash = "";
	return url.origin;
}

function parseEnvironmentDescriptor(value: unknown): EnvironmentDescriptor {
	if (!isRecord(value) || typeof value.environmentId !== "string" || !value.environmentId.trim()) {
		throw new T3ClientError("invalid-response");
	}
	return { environmentId: value.environmentId.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
