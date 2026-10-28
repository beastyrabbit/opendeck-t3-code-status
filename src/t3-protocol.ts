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

// Retain only fields used by the status display, never conversation or file data.
export function parseThread(value: unknown): T3ThreadShell {
	const invalid = () => new LiveConnectionError("invalid-response");
	if (
		!record(value) ||
		!textValue(value.id) ||
		!textValue(value.status, 64) ||
		typeof value.hasActionableProposedPlan !== "boolean" ||
		!record(value.lineage)
	)
		throw invalid();
	const date = (v: unknown): string | null => {
		if (v == null) return null;
		if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) throw invalid();
		return v;
	};
	const id = (v: unknown): string | null => {
		if (v == null) return null;
		if (!textValue(v)) throw invalid();
		return v;
	};
	const lineage = value.lineage;
	const request = value.pendingRuntimeRequest;
	if (request != null && (!record(request) || !textValue(request.kind, 128))) throw invalid();
	const tasks = value.pendingBackgroundTasks ?? [];
	if (!Array.isArray(tasks) || tasks.length > 1_000) throw invalid();
	const activity = value.activityRunStatus;
	if (activity != null && !textValue(activity, 64)) throw invalid();
	const guests = value.pendingGuestMessageCount ?? 0;
	if (!sequence(guests)) throw invalid();
	const updatedAt = date(value.updatedAt);
	if (updatedAt === null) throw invalid();
	return {
		id: value.id,
		parentThreadId: id(lineage.parentThreadId),
		relationshipToParent:
			lineage.relationshipToParent === "fork" || lineage.relationshipToParent === "subagent"
				? lineage.relationshipToParent
				: null,
		creationSource: textValue(value.creationSource, 64) ? value.creationSource : null,
		interactionMode: value.interactionMode === "plan" ? "plan" : "default",
		status: value.status,
		...(activity === undefined ? {} : { activityRunStatus: (activity as string | null) ?? null }),
		latestRunId: id(value.latestRunId),
		latestRunCompletedAt: date(value.latestRunCompletedAt),
		activeProviderThreadId: id(value.activeProviderThreadId),
		pendingRuntimeRequest: record(request)
			? {
					kind: request.kind as string,
					...(typeof request.blocking === "boolean" ? { blocking: request.blocking } : {}),
				}
			: null,
		pendingGuestMessageCount: guests,
		hasActionableProposedPlan: value.hasActionableProposedPlan,
		pendingBackgroundTasks: tasks.map((task: unknown) => {
			if (!record(task) || !textValue(task.kind, 64)) throw invalid();
			return { kind: task.kind, awaited: task.awaited === true };
		}),
		limitRecovery: record(value.limitRecovery),
		updatedAt,
		archivedAt: date(value.archivedAt),
		deletedAt: date(value.deletedAt),
		settledOverride:
			value.settledOverride === "settled" || value.settledOverride === "active"
				? value.settledOverride
				: null,
		snoozedAt: date(value.snoozedAt),
		snoozedUntil: date(value.snoozedUntil),
		...(value.lastVisitedAt === undefined ? {} : { lastVisitedAt: date(value.lastVisitedAt) }),
		...(typeof value.blockedOnThreadWait === "boolean"
			? { blockedOnThreadWait: value.blockedOnThreadWait }
			: {}),
	};
}
