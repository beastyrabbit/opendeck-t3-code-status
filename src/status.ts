import type { T3RunStatus, T3ShellSnapshot, T3ThreadShell, ThreadState, ThreadSummary } from "./types.js";

// These rules follow T3 Code's own client (packages/client-runtime models.ts and threadSettled.ts,
// packages/shared agentAwareness.ts) so the key agrees with the T3 sidebar.
const RUNNING_STATES = new Set<ThreadState>(["starting", "working"]);
const ACTIVE_RUN_STATUSES = new Set<T3RunStatus>(["preparing", "queued", "starting", "running", "waiting"]);
const GENERATING_RUN_STATUSES = new Set<T3RunStatus>(["preparing", "starting", "running"]);
const STARTING_RUN_STATUSES = new Set<T3RunStatus>(["preparing", "queued", "starting"]);

/** The run status T3 presents for a thread, or null when it never ran. */
function runtimeStatus(thread: T3ThreadShell): T3RunStatus | null {
	// Awaited background work parks the thread at idle instead of ending it.
	const parkAtIdle = backgroundWorkHoldsCompletion(thread) && thread.status !== "failed";
	if (thread.latestRunId === null && thread.activeProviderThreadId === null && !parkAtIdle) return null;
	return parkAtIdle ? "idle" : (thread.activityRunStatus ?? thread.status);
}

/** Whether the latest run itself is active. Background work parks the thread at idle without stopping it. */
function hasActiveRun(thread: T3ThreadShell): boolean {
	if (thread.latestRunId === null && thread.activeProviderThreadId === null) return false;
	return ACTIVE_RUN_STATUSES.has(thread.activityRunStatus ?? thread.status);
}

// Commands and monitors are often a dev server left running, so they hold only when awaited.
function backgroundWorkHoldsCompletion(thread: T3ThreadShell): boolean {
	return thread.pendingBackgroundTasks.some(
		(task) => task.awaited || task.kind === "subagent" || task.kind === "background_task",
	);
}

/** T3's sidebar calls a run "Waiting" while it waits on another thread or parks for background work. */
function isWaitingRun(thread: T3ThreadShell): boolean {
	return thread.blockedOnThreadWait === true || runtimeStatus(thread) === "idle";
}

/** T3's unread rule: the latest run finished after the user last opened the thread. */
function hasUnseenCompletion(thread: T3ThreadShell): boolean {
	if (!thread.latestRunCompletedAt || !thread.lastVisitedAt) return false;
	return Date.parse(thread.latestRunCompletedAt) > Date.parse(thread.lastVisitedAt);
}

function hasPendingApproval(thread: T3ThreadShell): boolean {
	const kind = thread.pendingRuntimeRequest?.kind;
	return kind !== undefined && kind !== "user_input" && kind !== "auth_refresh";
}

function hasPendingInput(thread: T3ThreadShell): boolean {
	const request = thread.pendingRuntimeRequest;
	if (request?.kind !== "user_input") return false;
	// A non-blocking question only needs the user once the run stops working past it.
	const status = runtimeStatus(thread);
	return request.blocking !== false || status === null || !GENERATING_RUN_STATUSES.has(status);
}

function isSubagent(thread: T3ThreadShell): boolean {
	return thread.relationshipToParent === "subagent";
}

/**
 * Parents whose live subagent waits for an approval. The coordinator answers a subagent's
 * questions, and provider-native subagents ask on their parent, so neither is flagged.
 */
function subagentApprovalParents(threads: readonly T3ThreadShell[]): Set<string> {
	const flagged = new Set<string>();
	let byId: Map<string, T3ThreadShell> | undefined;
	for (const child of threads) {
		if (!isSubagent(child) || child.creationSource === "provider" || !hasPendingApproval(child)) continue;
		const childRunLive =
			child.activityRunStatus !== undefined
				? child.activityRunStatus !== null
				: ["preparing", "starting", "running", "waiting"].includes(child.status);
		if (!childRunLive) continue;
		byId ??= new Map(threads.map((thread) => [thread.id, thread]));
		const seen = new Set([child.id]);
		let parentId = child.parentThreadId;
		while (parentId !== null && !seen.has(parentId)) {
			seen.add(parentId);
			flagged.add(parentId);
			const parent = byId.get(parentId);
			parentId = parent && isSubagent(parent) ? parent.parentThreadId : null;
		}
	}
	return flagged;
}

export function classifyThread(thread: T3ThreadShell, subagentApproval = false): ThreadState {
	if (subagentApproval || hasPendingApproval(thread)) return "approval";
	// Guest messages wait for the owner to send or dismiss them.
	if (hasPendingInput(thread) || thread.pendingGuestMessageCount > 0) return "input";
	const status = runtimeStatus(thread);
	const active = status !== null && ACTIVE_RUN_STATUSES.has(status);
	const runActive = hasActiveRun(thread);
	if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan && !runActive) return "plan";
	// T3's sidebar shows a failure caused by a usage limit as limited, with or without automatic recovery.
	if ((thread.limitRecovery || (status === "failed" && thread.usageLimitFailure)) && !runActive)
		return "limited";
	if (status === "failed") return "failed";
	if (status !== null && STARTING_RUN_STATUSES.has(status)) return "starting";
	if (active || backgroundWorkHoldsCompletion(thread)) return "working";
	if (thread.pendingBackgroundTasks.length > 0) return "monitoring";
	return "waiting";
}

export function isRelevantThread(thread: T3ThreadShell, now = Date.now(), subagentApproval = false): boolean {
	if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
	// Subagents show under their parent, which carries their approvals.
	if (isSubagent(thread)) return false;
	if (isEffectivelySnoozed(thread, now, subagentApproval)) return false;
	if (thread.settledOverride !== "settled") return true;
	// T3 settles threads itself; live work, requests, and guest messages stay visible after settlement.
	return (
		subagentApproval ||
		thread.pendingRuntimeRequest !== null ||
		thread.pendingGuestMessageCount > 0 ||
		hasActiveRun(thread)
	);
}

export function summarizeSnapshot(snapshot: T3ShellSnapshot, now = Date.now()): ThreadSummary {
	const summary = emptySummary();
	const approvalParents = subagentApprovalParents(snapshot.threads);
	for (const thread of snapshot.threads) {
		const subagentApproval = approvalParents.has(thread.id);
		if (!isRelevantThread(thread, now, subagentApproval)) continue;
		const state = classifyThread(thread, subagentApproval);
		summary[state] += 1;
		summary.total += 1;
		if (thread.pendingBackgroundTasks.length > 0) summary.background += 1;
		if (RUNNING_STATES.has(state) && isWaitingRun(thread)) summary.blocked += 1;
		if ((state === "waiting" || state === "monitoring") && hasUnseenCompletion(thread)) summary.unseen += 1;
	}
	summary.running = [...RUNNING_STATES].reduce((sum, state) => sum + summary[state], 0);
	summary.attention = summary.total - summary.running;
	return summary;
}

export function emptySummary(): ThreadSummary {
	return {
		total: 0,
		running: 0,
		attention: 0,
		approval: 0,
		input: 0,
		plan: 0,
		limited: 0,
		failed: 0,
		starting: 0,
		working: 0,
		monitoring: 0,
		waiting: 0,
		background: 0,
		blocked: 0,
		unseen: 0,
	};
}

// Only a request for the user or a fresh failure ends a snooze early; completed runs do not.
function isEffectivelySnoozed(thread: T3ThreadShell, now: number, subagentApproval: boolean): boolean {
	if (thread.snoozedUntil === null) return false;
	const wakeAt = Date.parse(thread.snoozedUntil);
	if (Number.isNaN(wakeAt) || wakeAt <= now) return false;
	if (thread.pendingRuntimeRequest !== null || subagentApproval || thread.pendingGuestMessageCount > 0)
		return false;
	if (runtimeStatus(thread) !== "failed") return true;
	const failedAt =
		thread.status === "failed" ? (thread.latestRunCompletedAt ?? thread.updatedAt) : thread.updatedAt;
	return thread.snoozedAt !== null && Date.parse(failedAt) <= Date.parse(thread.snoozedAt);
}
