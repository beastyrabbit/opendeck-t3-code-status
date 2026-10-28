import type { T3ThreadShell } from "./types.js";

export type LiveErrorCode =
	| "pairing-required"
	| "authorization-required"
	| "invalid-link"
	| "insecure-origin"
	| "invalid-response"
	| "identity-mismatch"
	| "storage-error"
	| "offline"
	| "connecting"
	| "busy"
	| "unsupported-version"
	| "invalid-host"
	| "ssh-failed"
	| "t3-missing"
	| "t3-failed";
export class LiveConnectionError extends Error {
	constructor(readonly code: LiveErrorCode) {
		super(code);
	}
}

export const MAX_ENVIRONMENTS = 16;
export const MAX_THREADS = 50_000;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** T3 rejects WebSocket clients that do not declare this orchestration protocol. */
export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";

/** Rejects environments that do not speak the orchestration protocol this plugin understands. */
export function assertSupportedProtocol(descriptor: Record<string, unknown>): void {
	if (descriptor.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION)
		throw new LiveConnectionError("unsupported-version");
}

export function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function textValue(value: unknown, max = 1024): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}
export function sequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function originFrom(value: string, allowHttp: boolean): string {
	try {
		const url = new URL(value);
		if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error();
		if (
			url.protocol === "http:" &&
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
			!allowHttp
		) {
			throw new LiveConnectionError("insecure-origin");
		}
		return url.origin;
	} catch (error) {
		if (error instanceof LiveConnectionError) throw error;
		throw new LiveConnectionError("invalid-link");
	}
}
export function parsePairingLink(link: string, allowHttp = false): { origin: string; credential: string } {
	try {
		if (!textValue(link, 16_384)) throw new Error();
		const url = new URL(link.trim());
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
		const credential = new URLSearchParams(url.hash.slice(1)).get("token") || url.searchParams.get("token");
		if (!textValue(credential, 8192)) throw new Error();
		return { origin: originFrom(url.searchParams.get("host") || url.origin, allowHttp), credential };
	} catch (error) {
		if (error instanceof LiveConnectionError) throw error;
		throw new LiveConnectionError("invalid-link");
	}
}

const invalid = () => new LiveConnectionError("invalid-response");

function date(value: unknown): string | null {
	if (value == null) return null;
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw invalid();
	return value;
}

function id(value: unknown): string | null {
	if (value == null) return null;
	if (!textValue(value)) throw invalid();
	return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
	return allowed.includes(value as T) ? (value as T) : null;
}

function parseRequest(value: unknown): T3ThreadShell["pendingRuntimeRequest"] {
	if (value == null) return null;
	if (!record(value) || !textValue(value.kind, 128)) throw invalid();
	return { kind: value.kind, ...(typeof value.blocking === "boolean" ? { blocking: value.blocking } : {}) };
}

function parseTasks(value: unknown): T3ThreadShell["pendingBackgroundTasks"] {
	const tasks = value ?? [];
	if (!Array.isArray(tasks) || tasks.length > 1_000) throw invalid();
	return tasks.map((task: unknown) => {
		if (!record(task) || !textValue(task.kind, 64)) throw invalid();
		return { kind: task.kind, awaited: task.awaited === true };
	});
}

const TERMINAL_RUN_STATUSES = new Set([
	"idle",
	"completed",
	"interrupted",
	"failed",
	"cancelled",
	"rolled_back",
]);

/** When a server omits the completion time, T3 dates a finished run by the thread's last update. */
function completedAt(value: Record<string, unknown>, updatedAt: string): string | null {
	if (value.latestRunCompletedAt !== undefined) return date(value.latestRunCompletedAt);
	return value.latestRunId != null && TERMINAL_RUN_STATUSES.has(value.status as string) ? updatedAt : null;
}

// Retain only fields used by the status display, never conversation or file data.
export function parseThread(value: unknown): T3ThreadShell {
	if (
		!record(value) ||
		!textValue(value.id) ||
		!textValue(value.status, 64) ||
		typeof value.hasActionableProposedPlan !== "boolean" ||
		!record(value.lineage)
	)
		throw invalid();
	const lineage = value.lineage;
	const activity = value.activityRunStatus;
	if (activity != null && !textValue(activity, 64)) throw invalid();
	const guests = value.pendingGuestMessageCount ?? 0;
	if (!sequence(guests)) throw invalid();
	const updatedAt = date(value.updatedAt);
	if (updatedAt === null) throw invalid();
	return {
		id: value.id,
		parentThreadId: id(lineage.parentThreadId),
		relationshipToParent: oneOf(lineage.relationshipToParent, ["fork", "subagent"]),
		creationSource: textValue(value.creationSource, 64) ? value.creationSource : null,
		interactionMode: value.interactionMode === "plan" ? "plan" : "default",
		status: value.status,
		...(activity === undefined ? {} : { activityRunStatus: (activity as string | null) ?? null }),
		latestRunId: id(value.latestRunId),
		latestRunCompletedAt: completedAt(value, updatedAt),
		activeProviderThreadId: id(value.activeProviderThreadId),
		pendingRuntimeRequest: parseRequest(value.pendingRuntimeRequest),
		pendingGuestMessageCount: guests,
		hasActionableProposedPlan: value.hasActionableProposedPlan,
		pendingBackgroundTasks: parseTasks(value.pendingBackgroundTasks),
		limitRecovery: record(value.limitRecovery),
		usageLimitFailure: value.lastErrorClass === "usage_limit",
		updatedAt,
		archivedAt: date(value.archivedAt),
		deletedAt: date(value.deletedAt),
		settledOverride: oneOf(value.settledOverride, ["settled", "active"]),
		snoozedAt: date(value.snoozedAt),
		snoozedUntil: date(value.snoozedUntil),
		...(value.lastVisitedAt === undefined ? {} : { lastVisitedAt: date(value.lastVisitedAt) }),
		...(typeof value.blockedOnThreadWait === "boolean"
			? { blockedOnThreadWait: value.blockedOnThreadWait }
			: {}),
	};
}
