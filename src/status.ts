import type { T3ShellSnapshot, T3ThreadShell, ThreadState, ThreadSummary } from "./types.js";

const RUNNING_STATES = new Set<ThreadState>(["starting", "working"]);
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_AUTO_SETTLE_AFTER_DAYS = 3;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

export function classifyThread(thread: T3ThreadShell): ThreadState {
	if (thread.hasPendingApprovals) return "approval";
	if (thread.hasPendingUserInput) return "input";
	if (thread.session?.status === "starting") return "starting";
	if (thread.session?.status === "running") return "working";
	if (thread.session?.status === "error") return "failed";
	if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan && isLatestTurnSettled(thread)) {
		return "plan";
	}
	if (thread.backgroundLiveness === "working") return "working";
	if (thread.backgroundLiveness === "monitoring") return "monitoring";
	return "waiting";
}

function isLatestTurnSettled(thread: T3ThreadShell): boolean {
	if (!thread.latestTurn?.startedAt || !thread.latestTurn.completedAt) return false;
	return thread.session?.status !== "running";
}

export function isRelevantThread(
	thread: T3ThreadShell,
	now = Date.now(),
	autoSettleAfterDays: number | null = DEFAULT_AUTO_SETTLE_AFTER_DAYS,
): boolean {
	if (thread.archivedAt !== null) return false;
	if (isEffectivelySnoozed(thread, now)) return false;
	return !isEffectivelySettled(thread, now, autoSettleAfterDays);
}

export function summarizeSnapshot(
	snapshot: T3ShellSnapshot,
	now = Date.now(),
	autoSettleAfterDays: number | null = DEFAULT_AUTO_SETTLE_AFTER_DAYS,
): ThreadSummary {
	const counts: Record<ThreadState, number> = {
		approval: 0,
		input: 0,
		failed: 0,
		starting: 0,
		working: 0,
		monitoring: 0,
		plan: 0,
		waiting: 0,
	};

	for (const thread of snapshot.threads) {
		if (!isRelevantThread(thread, now, autoSettleAfterDays)) continue;
		counts[classifyThread(thread)] += 1;
	}

	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	const running = [...RUNNING_STATES].reduce((sum, state) => sum + counts[state], 0);
	return {
		...counts,
		total,
		running,
		attention: total - running,
	};
}

export function emptySummary(): ThreadSummary {
	return {
		total: 0,
		running: 0,
		attention: 0,
		approval: 0,
		input: 0,
		failed: 0,
		starting: 0,
		working: 0,
		monitoring: 0,
		plan: 0,
		waiting: 0,
	};
}

function isEffectivelySnoozed(thread: T3ThreadShell, now: number): boolean {
	if (thread.snoozedUntil == null) return false;
	const wakeAt = Date.parse(thread.snoozedUntil);
	if (Number.isNaN(wakeAt) || wakeAt <= now) return false;
	return !raisedHandWhileSnoozed(thread);
}

function raisedHandWhileSnoozed(thread: T3ThreadShell): boolean {
	if (thread.hasPendingApprovals || thread.hasPendingUserInput) return true;
	if (
		thread.session?.status === "error" &&
		(thread.snoozedAt == null || Date.parse(thread.session.updatedAt ?? "") > Date.parse(thread.snoozedAt))
	) {
		return true;
	}
	if (
		thread.snoozedAt != null &&
		thread.latestTurn?.state === "completed" &&
		thread.latestTurn.completedAt != null &&
		Date.parse(thread.latestTurn.completedAt) > Date.parse(thread.snoozedAt)
	) {
		return true;
	}
	return false;
}

function isEffectivelySettled(
	thread: T3ThreadShell,
	now: number,
	autoSettleAfterDays: number | null,
): boolean {
	if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
	if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
	if (hasQueuedTurnStart(thread, now)) {
		const serverAdjudicated =
			thread.settledOverride === "settled" &&
			thread.settledAt !== null &&
			thread.latestUserMessageAt != null &&
			Date.parse(thread.settledAt) >= Date.parse(thread.latestUserMessageAt);
		if (!serverAdjudicated) return false;
	}
	if (thread.settledOverride === "settled") return true;
	if (thread.settledOverride === "active") return false;
	if (autoSettleAfterDays === null) return false;

	const lastActivityAt = threadLastActivityAt(thread);
	if (lastActivityAt === null) return false;
	return lastActivityAt < now - autoSettleAfterDays * DAY_MS;
}

function hasQueuedTurnStart(thread: T3ThreadShell, now: number): boolean {
	if (thread.latestUserMessageAt == null || thread.session?.status === "error") return false;
	const messageAt = Date.parse(thread.latestUserMessageAt);
	if (Number.isNaN(messageAt) || !Number.isFinite(now)) return false;
	if (Math.abs(now - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
	if (thread.latestTurn === null) return true;
	return [thread.latestTurn.requestedAt, thread.latestTurn.startedAt, thread.latestTurn.completedAt].every(
		(candidate) => candidate == null || Date.parse(candidate) < messageAt,
	);
}

function threadLastActivityAt(thread: T3ThreadShell): number | null {
	const candidates = [
		thread.latestUserMessageAt,
		thread.latestTurn?.requestedAt,
		thread.latestTurn?.startedAt,
		thread.latestTurn?.completedAt,
	];
	let latest: number | null = null;
	for (const candidate of candidates) {
		if (candidate == null) continue;
		const timestamp = Date.parse(candidate);
		if (!Number.isNaN(timestamp) && (latest === null || timestamp > latest)) latest = timestamp;
	}
	return latest;
}
