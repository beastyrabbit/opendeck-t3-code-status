import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyThread, emptySummary, isRelevantThread, summarizeSnapshot } from "../src/status.js";
import { parseThread } from "../src/t3-protocol.js";
import {
	DEFAULT_REFRESH_SECONDS,
	MAX_REFRESH_SECONDS,
	MIN_REFRESH_SECONDS,
	normalizeSettings,
	type T3ShellSnapshot,
	type T3ThreadShell,
} from "../src/types.js";

const NOW = Date.parse("2030-01-01T12:00:00.000Z");

function thread(overrides: Partial<T3ThreadShell> = {}): T3ThreadShell {
	return {
		id: "thread-1",
		parentThreadId: null,
		relationshipToParent: null,
		creationSource: "web",
		interactionMode: "default",
		status: "idle",
		activityRunStatus: null,
		latestRunId: "run-1",
		latestRunCompletedAt: null,
		activeProviderThreadId: null,
		pendingRuntimeRequest: null,
		pendingGuestMessageCount: 0,
		hasActionableProposedPlan: false,
		pendingBackgroundTasks: [],
		limitRecovery: false,
		usageLimitFailure: false,
		updatedAt: "2030-01-01T11:00:00.000Z",
		archivedAt: null,
		deletedAt: null,
		settledOverride: null,
		snoozedAt: null,
		snoozedUntil: null,
		...overrides,
	};
}

function running(overrides: Partial<T3ThreadShell> = {}): T3ThreadShell {
	return thread({ status: "running", activityRunStatus: "running", ...overrides });
}

function snapshot(threads: T3ThreadShell[]): T3ShellSnapshot {
	return { snapshotSequence: 1, threads, updatedAt: "2030-01-01T12:00:00.000Z" };
}

describe("classifyThread", () => {
	const cases: Array<{ name: string; source: Partial<T3ThreadShell>; expected: string }> = [
		{
			name: "a provider approval wins over a running run",
			source: { status: "running", activityRunStatus: "running", pendingRuntimeRequest: { kind: "command" } },
			expected: "approval",
		},
		{
			name: "a blocking question needs input",
			source: {
				status: "running",
				activityRunStatus: "running",
				pendingRuntimeRequest: { kind: "user_input" },
			},
			expected: "input",
		},
		{
			name: "a non-blocking question does not interrupt a working run",
			source: {
				status: "running",
				activityRunStatus: "running",
				pendingRuntimeRequest: { kind: "user_input", blocking: false },
			},
			expected: "working",
		},
		{
			name: "a non-blocking question needs input once the run stops",
			source: { status: "completed", pendingRuntimeRequest: { kind: "user_input", blocking: false } },
			expected: "input",
		},
		{
			name: "an auth refresh is neither approval nor input",
			source: { status: "completed", pendingRuntimeRequest: { kind: "auth_refresh" } },
			expected: "waiting",
		},
		{
			name: "guest messages wait for the owner",
			source: { pendingGuestMessageCount: 2 },
			expected: "input",
		},
		{
			name: "an actionable plan needs review once the run ends",
			source: { status: "completed", interactionMode: "plan", hasActionableProposedPlan: true },
			expected: "plan",
		},
		{
			name: "a plan still being written is working",
			source: {
				status: "running",
				activityRunStatus: "running",
				interactionMode: "plan",
				hasActionableProposedPlan: true,
			},
			expected: "working",
		},
		{
			name: "a plan run that waits on a subagent is still working",
			source: {
				status: "running",
				activityRunStatus: "running",
				interactionMode: "plan",
				hasActionableProposedPlan: true,
				pendingBackgroundTasks: [{ kind: "subagent", awaited: false }],
			},
			expected: "working",
		},
		{
			name: "a usage limit waits for its reset",
			source: { status: "failed", limitRecovery: true },
			expected: "limited",
		},
		{
			name: "a usage-limit failure without automatic recovery is still limited",
			source: { status: "failed", usageLimitFailure: true },
			expected: "limited",
		},
		{ name: "a failed run", source: { status: "failed" }, expected: "failed" },
		{
			name: "a preparing run is starting",
			source: { status: "preparing", activityRunStatus: "preparing" },
			expected: "starting",
		},
		{ name: "a queued run is starting", source: { status: "queued" }, expected: "starting" },
		{
			name: "a draining run still works",
			source: { status: "waiting", activityRunStatus: "waiting" },
			expected: "working",
		},
		{
			name: "the activity run wins over a completed latest run",
			source: { status: "completed", activityRunStatus: "running" },
			expected: "working",
		},
		{
			name: "older servers without activityRunStatus use the run status",
			source: { status: "running", activityRunStatus: undefined },
			expected: "working",
		},
		{
			name: "awaited background work holds the thread working",
			source: { status: "completed", pendingBackgroundTasks: [{ kind: "subagent", awaited: false }] },
			expected: "working",
		},
		{
			name: "an awaited command holds the thread working",
			source: { status: "completed", pendingBackgroundTasks: [{ kind: "command", awaited: true }] },
			expected: "working",
		},
		{
			name: "an unawaited dev server is only monitoring",
			source: { status: "completed", pendingBackgroundTasks: [{ kind: "command", awaited: false }] },
			expected: "monitoring",
		},
		{ name: "a completed run waits", source: { status: "completed" }, expected: "waiting" },
		{
			name: "a thread that never ran waits",
			source: { status: "idle", latestRunId: null },
			expected: "waiting",
		},
	];

	for (const { name, source, expected } of cases) {
		test(name, () => {
			assert.equal(classifyThread(thread(source)), expected);
		});
	}

	test("a live subagent approval flags its parent", () => {
		assert.equal(classifyThread(thread(), true), "approval");
	});
});

describe("isRelevantThread", () => {
	test("keeps an open waiting thread", () => {
		assert.equal(isRelevantThread(thread(), NOW), true);
	});

	test("drops archived, deleted, and subagent threads", () => {
		assert.equal(isRelevantThread(running({ archivedAt: "2029-12-01T00:00:00.000Z" }), NOW), false);
		assert.equal(isRelevantThread(running({ deletedAt: "2029-12-01T00:00:00.000Z" }), NOW), false);
		assert.equal(
			isRelevantThread(running({ relationshipToParent: "subagent", parentThreadId: "p" }), NOW),
			false,
		);
		assert.equal(isRelevantThread(thread({ relationshipToParent: "fork", parentThreadId: "p" }), NOW), true);
	});

	test("drops settled threads unless they work or ask", () => {
		assert.equal(isRelevantThread(thread({ settledOverride: "settled", status: "completed" }), NOW), false);
		assert.equal(isRelevantThread(thread({ settledOverride: "settled", status: "failed" }), NOW), false);
		assert.equal(isRelevantThread(running({ settledOverride: "settled" }), NOW), true);
		assert.equal(
			isRelevantThread(
				running({
					settledOverride: "settled",
					pendingBackgroundTasks: [{ kind: "subagent", awaited: false }],
				}),
				NOW,
			),
			true,
		);
		assert.equal(
			isRelevantThread(
				thread({ settledOverride: "settled", pendingRuntimeRequest: { kind: "command" } }),
				NOW,
			),
			true,
		);
		assert.equal(isRelevantThread(thread({ settledOverride: "settled" }), NOW, true), true);
		assert.equal(
			isRelevantThread(thread({ settledOverride: "settled", pendingGuestMessageCount: 1 }), NOW),
			true,
		);
		assert.equal(isRelevantThread(thread({ settledOverride: "active" }), NOW), true);
	});

	test("drops a snoozed thread until its wake time", () => {
		assert.equal(isRelevantThread(thread({ snoozedUntil: "2030-01-02T00:00:00.000Z" }), NOW), false);
		assert.equal(isRelevantThread(thread({ snoozedUntil: "2030-01-01T11:00:00.000Z" }), NOW), true);
		assert.equal(isRelevantThread(thread({ snoozedUntil: "not a date" }), NOW), true);
	});

	test("a snoozed thread stays hidden while it works or completes", () => {
		const snoozed = { snoozedAt: "2030-01-01T10:00:00.000Z", snoozedUntil: "2030-01-02T00:00:00.000Z" };
		assert.equal(isRelevantThread(running(snoozed), NOW), false);
		assert.equal(
			isRelevantThread(
				thread({ ...snoozed, status: "completed", latestRunCompletedAt: "2030-01-01T11:00:00.000Z" }),
				NOW,
			),
			false,
		);
	});

	test("requests, guest messages, and fresh failures raise a snoozed thread's hand", () => {
		const snoozed = { snoozedAt: "2030-01-01T10:00:00.000Z", snoozedUntil: "2030-01-02T00:00:00.000Z" };
		assert.equal(
			isRelevantThread(thread({ ...snoozed, pendingRuntimeRequest: { kind: "user_input" } }), NOW),
			true,
		);
		assert.equal(
			isRelevantThread(
				thread({ ...snoozed, pendingRuntimeRequest: { kind: "user_input", blocking: false } }),
				NOW,
			),
			true,
		);
		assert.equal(isRelevantThread(thread({ ...snoozed, pendingGuestMessageCount: 1 }), NOW), true);
		assert.equal(isRelevantThread(thread(snoozed), NOW, true), true);
		assert.equal(
			isRelevantThread(
				thread({ ...snoozed, status: "failed", latestRunCompletedAt: "2030-01-01T11:00:00.000Z" }),
				NOW,
			),
			true,
		);
		assert.equal(
			isRelevantThread(
				thread({ ...snoozed, status: "failed", latestRunCompletedAt: "2030-01-01T09:00:00.000Z" }),
				NOW,
			),
			false,
		);
		assert.equal(isRelevantThread(thread({ ...snoozed, snoozedAt: null, status: "failed" }), NOW), true);
	});
});

describe("summarizeSnapshot", () => {
	test("counts open top-level threads and their working share", () => {
		const summary = summarizeSnapshot(
			snapshot([
				thread({ id: "starting", status: "starting", activityRunStatus: "starting" }),
				running({ id: "work-1" }),
				running({ id: "work-2" }),
				thread({
					id: "held",
					status: "completed",
					pendingBackgroundTasks: [{ kind: "background_task", awaited: false }],
				}),
				thread({
					id: "dev-server",
					status: "completed",
					pendingBackgroundTasks: [{ kind: "monitor", awaited: false }],
				}),
				thread({ id: "idle", status: "completed" }),
				running({ id: "archived", archivedAt: "2029-12-01T00:00:00.000Z" }),
				thread({ id: "settled", status: "completed", settledOverride: "settled" }),
				thread({ id: "sleeping", snoozedUntil: "2030-01-02T12:00:00.000Z" }),
				running({ id: "child", relationshipToParent: "subagent", parentThreadId: "work-1" }),
			]),
			NOW,
		);
		assert.deepEqual(summary, {
			...emptySummary(),
			total: 6,
			running: 4,
			attention: 2,
			starting: 1,
			working: 3,
			monitoring: 1,
			waiting: 1,
			background: 2,
			// The thread held open by its awaited background task only waits.
			blocked: 1,
		});
	});

	test("splits waiting runs out of running and counts finished threads the user has not opened", () => {
		const summary = summarizeSnapshot(
			snapshot([
				running({ id: "busy" }),
				running({ id: "on-subagent", blockedOnThreadWait: true }),
				thread({
					id: "unseen",
					status: "completed",
					latestRunCompletedAt: "2030-01-01T11:30:00.000Z",
					lastVisitedAt: "2030-01-01T11:00:00.000Z",
				}),
				thread({
					id: "seen",
					status: "completed",
					latestRunCompletedAt: "2030-01-01T11:00:00.000Z",
					lastVisitedAt: "2030-01-01T11:30:00.000Z",
				}),
				thread({
					id: "never-visited",
					status: "completed",
					latestRunCompletedAt: "2030-01-01T11:30:00.000Z",
				}),
				thread({
					id: "failed-unseen",
					status: "failed",
					latestRunCompletedAt: "2030-01-01T11:30:00.000Z",
					lastVisitedAt: "2030-01-01T11:00:00.000Z",
				}),
			]),
			NOW,
		);
		assert.equal(summary.running, 2);
		assert.equal(summary.blocked, 1);
		// Failures count as errors, not as unseen.
		assert.equal(summary.unseen, 1);
		assert.equal(summary.total, 6);
	});

	test("flags each parent up a live subagent chain that needs approval", () => {
		const summary = summarizeSnapshot(
			snapshot([
				running({ id: "root" }),
				running({ id: "middle", relationshipToParent: "subagent", parentThreadId: "root" }),
				running({
					id: "leaf",
					relationshipToParent: "subagent",
					parentThreadId: "middle",
					pendingRuntimeRequest: { kind: "file_change" },
				}),
			]),
			NOW,
		);
		assert.equal(summary.total, 1);
		assert.equal(summary.approval, 1);
	});

	test("ignores subagent questions, finished subagents, and provider-native subagents", () => {
		const child = (id: string, overrides: Partial<T3ThreadShell>) =>
			running({ id, relationshipToParent: "subagent", parentThreadId: "root", ...overrides });
		const summary = summarizeSnapshot(
			snapshot([
				running({ id: "root" }),
				child("question", { pendingRuntimeRequest: { kind: "user_input" } }),
				child("finished", {
					status: "completed",
					activityRunStatus: null,
					pendingRuntimeRequest: { kind: "command" },
				}),
				child("native", { creationSource: "provider", pendingRuntimeRequest: { kind: "command" } }),
			]),
			NOW,
		);
		assert.equal(summary.approval, 0);
		assert.equal(summary.working, 1);
	});

	test("survives a parent cycle", () => {
		const summary = summarizeSnapshot(
			snapshot([
				running({ id: "a", relationshipToParent: "subagent", parentThreadId: "b" }),
				running({
					id: "b",
					relationshipToParent: "subagent",
					parentThreadId: "a",
					pendingRuntimeRequest: { kind: "command" },
				}),
			]),
			NOW,
		);
		assert.equal(summary.total, 0);
	});
});

test("emptySummary returns a fresh all-zero summary", () => {
	const first = emptySummary();
	const second = emptySummary();

	assert.deepEqual(first, {
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
	});
	assert.notEqual(first, second);
});

describe("normalizeSettings", () => {
	test("maps legacy displays and rejects unknown values", () => {
		assert.equal(normalizeSettings({ displayMode: "threads" }).displayMode, "working");
		assert.equal(normalizeSettings({ displayMode: "questions" }).displayMode, "needs");
		assert.equal(normalizeSettings({ displayMode: "approval", theme: "gauge" }).theme, "gauge");
		const unknown = { displayMode: "constructor", theme: "toString" } as unknown as Parameters<
			typeof normalizeSettings
		>[0];
		assert.deepEqual(normalizeSettings(unknown), {
			displayMode: "combined",
			theme: "counter",
			refreshSeconds: DEFAULT_REFRESH_SECONDS,
		});
	});

	test("uses the default when the setting is absent or not finite", () => {
		assert.deepEqual(normalizeSettings(undefined), {
			displayMode: "combined",
			theme: "counter",
			refreshSeconds: DEFAULT_REFRESH_SECONDS,
		});
		assert.deepEqual(normalizeSettings({}), {
			displayMode: "combined",
			theme: "counter",
			refreshSeconds: DEFAULT_REFRESH_SECONDS,
		});
		assert.deepEqual(normalizeSettings({ refreshSeconds: Number.NaN }), {
			displayMode: "combined",
			theme: "counter",
			refreshSeconds: DEFAULT_REFRESH_SECONDS,
		});
		assert.deepEqual(normalizeSettings({ refreshSeconds: Number.POSITIVE_INFINITY }), {
			displayMode: "combined",
			theme: "counter",
			refreshSeconds: DEFAULT_REFRESH_SECONDS,
		});
	});

	test("rounds values and clamps them to the supported interval", () => {
		assert.deepEqual(normalizeSettings({ refreshSeconds: 21.6 }), {
			displayMode: "combined",
			theme: "counter",
			refreshSeconds: 22,
		});
		assert.deepEqual(normalizeSettings({ refreshSeconds: MIN_REFRESH_SECONDS - 1 }), {
			displayMode: "combined",
			theme: "counter",
			refreshSeconds: MIN_REFRESH_SECONDS,
		});
		assert.deepEqual(normalizeSettings({ refreshSeconds: MAX_REFRESH_SECONDS + 1 }), {
			displayMode: "combined",
			theme: "counter",
			refreshSeconds: MAX_REFRESH_SECONDS,
		});
	});

	test("accepts the numeric strings emitted by a property inspector", () => {
		assert.deepEqual(normalizeSettings({ refreshSeconds: "45" } as unknown as { refreshSeconds: number }), {
			displayMode: "combined",
			theme: "counter",
			refreshSeconds: 45,
		});
	});
});

describe("parseThread", () => {
	const wire = {
		id: "thread-1",
		status: "running",
		hasActionableProposedPlan: false,
		lineage: { parentThreadId: null, relationshipToParent: null },
		updatedAt: "2030-01-01T11:00:00.000Z",
	};

	test("keeps when the user last opened a thread and whether its run waits on another thread", () => {
		const parsed = parseThread({
			...wire,
			lastVisitedAt: "2030-01-01T10:00:00.000Z",
			blockedOnThreadWait: true,
		});
		assert.equal(parsed.lastVisitedAt, "2030-01-01T10:00:00.000Z");
		assert.equal(parsed.blockedOnThreadWait, true);
		const older = parseThread(wire);
		assert.equal("lastVisitedAt" in older, false);
		assert.equal("blockedOnThreadWait" in older, false);
		assert.throws(() => parseThread({ ...wire, lastVisitedAt: "not a date" }));
	});

	test("keeps whether the latest failure was a usage limit", () => {
		assert.equal(
			parseThread({ ...wire, status: "failed", lastErrorClass: "usage_limit" }).usageLimitFailure,
			true,
		);
		assert.equal(
			parseThread({ ...wire, status: "failed", lastErrorClass: "provider" }).usageLimitFailure,
			false,
		);
		assert.equal(parseThread(wire).usageLimitFailure, false);
	});

	test("dates a finished run by its last update when the server omits the completion time, as T3 does", () => {
		const finished = { ...wire, status: "completed", latestRunId: "run-1" };
		assert.equal(parseThread(finished).latestRunCompletedAt, "2030-01-01T11:00:00.000Z");
		assert.equal(parseThread({ ...finished, latestRunCompletedAt: null }).latestRunCompletedAt, null);
		assert.equal(parseThread({ ...wire, latestRunId: "run-1" }).latestRunCompletedAt, null);
		assert.equal(parseThread({ ...finished, latestRunId: null }).latestRunCompletedAt, null);
		const unseen = summarizeSnapshot(
			{
				snapshotSequence: 1,
				threads: [parseThread({ ...finished, lastVisitedAt: "2030-01-01T10:00:00.000Z" })],
				updatedAt: "2030-01-01T12:00:00.000Z",
			},
			NOW,
		);
		assert.equal(unseen.unseen, 1);
	});
});
