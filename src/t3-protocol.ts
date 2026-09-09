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
	| "busy";
export class LiveConnectionError extends Error {
	constructor(readonly code: LiveErrorCode) {
		super(code);
	}
}

export const MAX_ENVIRONMENTS = 16;
export const MAX_THREADS = 50_000;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

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
	if (
		!record(value) ||
		!textValue(value.id) ||
		!["hasPendingApprovals", "hasPendingUserInput", "hasActionableProposedPlan"].every(
			(key) => typeof value[key] === "boolean",
		)
	) {
		throw new LiveConnectionError("invalid-response");
	}
	const date = (v: unknown): string | null => {
		if (v == null) return null;
		if (typeof v !== "string" || !Number.isFinite(Date.parse(v)))
			throw new LiveConnectionError("invalid-response");
		return v;
	};
	const session = value.session;
	const turn = value.latestTurn;
	if (session != null && (!record(session) || !textValue(session.status, 64)))
		throw new LiveConnectionError("invalid-response");
	if (
		turn != null &&
		(!record(turn) || !["running", "interrupted", "completed", "error"].includes(String(turn.state)))
	)
		throw new LiveConnectionError("invalid-response");
	return {
		id: value.id,
		interactionMode: value.interactionMode === "plan" ? "plan" : "default",
		archivedAt: date(value.archivedAt),
		createdAt: date(value.createdAt),
		settledAt: date(value.settledAt),
		settledOverride:
			value.settledOverride === "settled" || value.settledOverride === "active"
				? value.settledOverride
				: null,
		latestUserMessageAt: date(value.latestUserMessageAt),
		snoozedAt: date(value.snoozedAt),
		snoozedUntil: date(value.snoozedUntil),
		hasPendingApprovals: value.hasPendingApprovals as boolean,
		hasPendingUserInput: value.hasPendingUserInput as boolean,
		hasActionableProposedPlan: value.hasActionableProposedPlan as boolean,
		backgroundLiveness:
			value.backgroundLiveness === "working" || value.backgroundLiveness === "monitoring"
				? value.backgroundLiveness
				: null,
		session: record(session)
			? { status: session.status as string, updatedAt: date(session.updatedAt) ?? undefined }
			: null,
		latestTurn: record(turn)
			? {
					state: turn.state as "running" | "interrupted" | "completed" | "error",
					requestedAt: date(turn.requestedAt),
					startedAt: date(turn.startedAt),
					completedAt: date(turn.completedAt),
				}
			: null,
	};
}
