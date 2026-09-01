import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyThread, emptySummary, isRelevantThread, summarizeSnapshot } from "../src/status.js";
import {
	DEFAULT_REFRESH_SECONDS,
	MAX_REFRESH_SECONDS,
	MIN_REFRESH_SECONDS,
	normalizeSettings,
	type T3ShellSnapshot,
	type T3ThreadShell,
} from "../src/types.js";

function thread(overrides: Partial<T3ThreadShell> = {}): T3ThreadShell {
	return {
		id: "thread-1",
		interactionMode: "default",
		archivedAt: null,
		createdAt: "2029-12-01T12:00:00.000Z",
		settledOverride: null,
		settledAt: null,
		latestUserMessageAt: null,
		snoozedAt: null,
		snoozedUntil: null,
		hasPendingApprovals: false,
		hasPendingUserInput: false,
		hasActionableProposedPlan: false,
		backgroundLiveness: null,
		latestTurn: null,
		session: null,
		...overrides,
	};
}

describe("classifyThread", () => {
	const cases: Array<{ name: string; source: Partial<T3ThreadShell>; expected: string }> = [
		{
			name: "approval wins over every lower-priority signal",
			source: {
				hasPendingApprovals: true,
				hasPendingUserInput: true,
				session: { status: "running" },
			},
			expected: "approval",
		},
		{
			name: "user input wins over a failed session",
			source: { hasPendingUserInput: true, session: { status: "error" } },
			expected: "input",
		},
		{
			name: "session errors are failures",
			source: { backgroundLiveness: "working", session: { status: "error" } },
			expected: "failed",
		},
		{
			name: "a session error wins over a stale running turn",
			source: { session: { status: "error" }, latestTurn: { state: "running" } },
			expected: "failed",
		},
		{
			name: "a running session wins over a stale turn error",
			source: { session: { status: "running" }, latestTurn: { state: "error" } },
			expected: "working",
		},
		{
			name: "a stale turn error does not override a resting session",
			source: { session: { status: "stopped" }, latestTurn: { state: "error" } },
			expected: "waiting",
		},
		{
			name: "a starting session is active",
			source: { session: { status: "starting" } },
			expected: "starting",
		},
		{
			name: "a running session is working",
			source: { session: { status: "running" } },
			expected: "working",
		},
		{
			name: "a stale running turn does not override a resting session",
			source: { session: { status: "stopped" }, latestTurn: { state: "running" } },
			expected: "waiting",
		},
		{
			name: "background work is working",
			source: { backgroundLiveness: "working" },
			expected: "working",
		},
		{
			name: "background monitoring stays active",
			source: { backgroundLiveness: "monitoring" },
			expected: "monitoring",
		},
		{
			name: "a completed actionable turn in plan mode needs attention when otherwise ready",
			source: {
				interactionMode: "plan",
				hasActionableProposedPlan: true,
				latestTurn: {
					state: "completed",
					startedAt: "2030-01-01T11:59:00.000Z",
					completedAt: "2030-01-01T12:00:00.000Z",
				},
			},
			expected: "plan",
		},
		...(["working", "monitoring"] as const).map((backgroundLiveness) => ({
			name: `an actionable settled plan outranks background ${backgroundLiveness}`,
			source: {
				interactionMode: "plan" as const,
				hasActionableProposedPlan: true,
				backgroundLiveness,
				latestTurn: {
					state: "completed" as const,
					startedAt: "2030-01-01T11:59:00.000Z",
					completedAt: "2030-01-01T12:00:00.000Z",
				},
			},
			expected: "plan",
		})),
		{
			name: "a proposed plan is not actionable in default interaction mode",
			source: {
				hasActionableProposedPlan: true,
				latestTurn: {
					state: "completed",
					startedAt: "2030-01-01T11:59:00.000Z",
					completedAt: "2030-01-01T12:00:00.000Z",
				},
			},
			expected: "waiting",
		},
		{
			name: "an unfinished plan turn does not ask for attention yet",
			source: {
				interactionMode: "plan",
				hasActionableProposedPlan: true,
				latestTurn: { state: "running", startedAt: "2030-01-01T11:59:00.000Z" },
			},
			expected: "waiting",
		},
		{ name: "a thread without signals is waiting", source: {}, expected: "waiting" },
	];

	for (const testCase of cases) {
		test(testCase.name, () => {
			assert.equal(classifyThread(thread(testCase.source)), testCase.expected);
		});
	}
});

describe("isRelevantThread", () => {
	const now = Date.parse("2030-01-01T12:00:00.000Z");

	test("keeps an open waiting thread", () => {
		assert.equal(isRelevantThread(thread(), now), true);
	});

	test("drops archived threads even while their session says running", () => {
		assert.equal(
			isRelevantThread(
				thread({ archivedAt: "2029-12-31T12:00:00.000Z", session: { status: "running" } }),
				now,
			),
			false,
		);
	});

	test("drops an explicitly settled thread but does not infer settlement from settledAt alone", () => {
		assert.equal(isRelevantThread(thread({ settledOverride: "settled" }), now), false);
		assert.equal(isRelevantThread(thread({ settledAt: "2029-12-31T12:00:00.000Z" }), now), true);
	});

	test("keeps explicitly settled threads while their session is genuinely running", () => {
		assert.equal(
			isRelevantThread(thread({ settledOverride: "settled", session: { status: "running" } }), now),
			true,
		);
	});

	test("drops explicitly settled threads when only a stale turn says running", () => {
		assert.equal(
			isRelevantThread(
				thread({
					settledOverride: "settled",
					session: { status: "stopped" },
					latestTurn: { state: "running" },
				}),
				now,
			),
			false,
		);
	});

	test("an explicit active override suppresses automatic inactivity settlement", () => {
		assert.equal(
			isRelevantThread(
				thread({
					settledOverride: "active",
					latestUserMessageAt: "2029-12-20T12:00:00.000Z",
				}),
				now,
			),
			true,
		);
	});

	test("drops a sleeping waiting thread until its wake time", () => {
		assert.equal(isRelevantThread(thread({ snoozedUntil: "2030-01-01T12:00:01.000Z" }), now), false);
		assert.equal(isRelevantThread(thread({ snoozedUntil: "2030-01-01T11:59:59.000Z" }), now), true);
	});

	test("a running session stays snoozed, while pending user action raises its hand", () => {
		assert.equal(
			isRelevantThread(
				thread({ snoozedUntil: "2030-01-02T12:00:00.000Z", session: { status: "running" } }),
				now,
			),
			false,
		);
		assert.equal(
			isRelevantThread(thread({ snoozedUntil: "2030-01-02T12:00:00.000Z", hasPendingApprovals: true }), now),
			true,
		);
	});

	test("treats an invalid wake timestamp as open", () => {
		assert.equal(isRelevantThread(thread({ snoozedUntil: "not-a-date" }), now), true);
	});

	test("only a fresh failure or a completion after the snooze raises its hand", () => {
		const snoozedAt = "2030-01-01T10:00:00.000Z";
		const snoozedUntil = "2030-01-02T12:00:00.000Z";
		assert.equal(
			isRelevantThread(
				thread({
					snoozedAt,
					snoozedUntil,
					session: { status: "error", updatedAt: "2030-01-01T09:59:00.000Z" },
				}),
				now,
			),
			false,
		);
		assert.equal(
			isRelevantThread(
				thread({
					snoozedAt,
					snoozedUntil,
					session: { status: "error", updatedAt: "2030-01-01T10:01:00.000Z" },
				}),
				now,
			),
			true,
		);
		assert.equal(
			isRelevantThread(
				thread({
					snoozedAt,
					snoozedUntil,
					latestTurn: {
						state: "completed",
						completedAt: "2030-01-01T10:01:00.000Z",
					},
				}),
				now,
			),
			true,
		);
	});

	test("auto-settles only beyond the default three-day inactivity window", () => {
		assert.equal(isRelevantThread(thread({ latestUserMessageAt: "2029-12-29T11:59:59.999Z" }), now), false);
		assert.equal(isRelevantThread(thread({ latestUserMessageAt: "2029-12-29T12:00:00.000Z" }), now), true);
		assert.equal(
			isRelevantThread(thread({ latestUserMessageAt: "2029-12-29T11:59:59.999Z" }), now, null),
			true,
		);
		assert.equal(
			isRelevantThread(thread({ latestUserMessageAt: "2029-12-31T11:59:59.999Z" }), now, 1),
			false,
		);
	});

	test("uses the latest valid user or turn timestamp for inactivity", () => {
		assert.equal(
			isRelevantThread(
				thread({
					latestUserMessageAt: "2029-12-20T12:00:00.000Z",
					latestTurn: {
						state: "completed",
						requestedAt: "2029-12-20T12:00:00.000Z",
						startedAt: "2029-12-31T11:00:00.000Z",
						completedAt: "2029-12-31T12:00:00.000Z",
					},
				}),
				now,
			),
			true,
		);
		assert.equal(
			isRelevantThread(
				thread({
					createdAt: "2029-12-01T12:00:00.000Z",
					latestUserMessageAt: null,
					latestTurn: null,
				}),
				now,
			),
			true,
		);
	});

	test("pending work and live sessions block every settlement path", () => {
		for (const source of [
			{ hasPendingApprovals: true },
			{ hasPendingUserInput: true },
			{ session: { status: "starting" } },
			{ session: { status: "running" } },
		] satisfies Array<Partial<T3ThreadShell>>) {
			assert.equal(
				isRelevantThread(
					thread({
						...source,
						settledOverride: "settled",
						latestUserMessageAt: "2029-12-20T12:00:00.000Z",
					}),
					now,
				),
				true,
			);
		}
	});

	test("a newly queued turn blocks settlement until adoption or the two-minute grace expires", () => {
		const messageAt = "2030-01-01T11:59:00.000Z";
		const queued = thread({
			settledOverride: "settled",
			settledAt: "2030-01-01T11:58:00.000Z",
			latestUserMessageAt: messageAt,
		});
		assert.equal(isRelevantThread(queued, now), true);
		assert.equal(
			isRelevantThread(
				thread({
					...queued,
					latestTurn: { state: "running", requestedAt: messageAt },
				}),
				now,
			),
			false,
		);
		assert.equal(
			isRelevantThread(
				thread({
					...queued,
					settledAt: "2030-01-01T12:00:00.000Z",
				}),
				now,
			),
			false,
		);
		assert.equal(
			isRelevantThread(
				thread({
					...queued,
					latestUserMessageAt: "2030-01-01T11:57:59.999Z",
				}),
				now,
			),
			false,
		);
	});
});

test("summarizeSnapshot reports six of seven visible parent threads as working", () => {
	const now = Date.parse("2030-01-01T12:00:00.000Z");
	const states: T3ThreadShell[] = [
		thread({ id: "starting", session: { status: "starting" } }),
		thread({ id: "session-work-1", session: { status: "running" } }),
		thread({ id: "session-work-2", session: { status: "running" } }),
		thread({ id: "background-work-1", backgroundLiveness: "working" }),
		thread({ id: "background-work-2", backgroundLiveness: "working" }),
		thread({ id: "background-work-3", backgroundLiveness: "working" }),
		thread({ id: "waiting" }),
		thread({ id: "archived", archivedAt: "2029-12-01T00:00:00.000Z", session: { status: "running" } }),
		thread({ id: "settled", settledOverride: "settled" }),
		thread({ id: "sleeping", snoozedUntil: "2030-01-02T12:00:00.000Z" }),
		thread({ id: "stale", latestUserMessageAt: "2029-12-20T12:00:00.000Z" }),
	];
	const snapshot: T3ShellSnapshot = {
		snapshotSequence: 42,
		threads: states,
		updatedAt: "2030-01-01T12:00:00.000Z",
	};

	assert.deepEqual(summarizeSnapshot(snapshot, now), {
		total: 7,
		running: 6,
		attention: 1,
		approval: 0,
		input: 0,
		failed: 0,
		starting: 1,
		working: 5,
		monitoring: 0,
		plan: 0,
		waiting: 1,
	});
});

test("monitoring remains visible but does not count as working", () => {
	const now = Date.parse("2030-01-01T12:00:00.000Z");
	const snapshot: T3ShellSnapshot = {
		snapshotSequence: 43,
		threads: [
			thread({ id: "working", backgroundLiveness: "working" }),
			thread({ id: "monitoring", backgroundLiveness: "monitoring" }),
		],
		updatedAt: "2030-01-01T12:00:00.000Z",
	};
	const summary = summarizeSnapshot(snapshot, now);
	assert.equal(summary.total, 2);
	assert.equal(summary.running, 1);
	assert.equal(summary.monitoring, 1);
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
		failed: 0,
		starting: 0,
		working: 0,
		monitoring: 0,
		plan: 0,
		waiting: 0,
	});
	assert.notEqual(first, second);
});

describe("normalizeSettings", () => {
	test("uses the default when the setting is absent or not finite", () => {
		assert.deepEqual(normalizeSettings(undefined), { refreshSeconds: DEFAULT_REFRESH_SECONDS });
		assert.deepEqual(normalizeSettings({}), { refreshSeconds: DEFAULT_REFRESH_SECONDS });
		assert.deepEqual(normalizeSettings({ refreshSeconds: Number.NaN }), {
			refreshSeconds: DEFAULT_REFRESH_SECONDS,
		});
		assert.deepEqual(normalizeSettings({ refreshSeconds: Number.POSITIVE_INFINITY }), {
			refreshSeconds: DEFAULT_REFRESH_SECONDS,
		});
	});

	test("rounds values and clamps them to the supported interval", () => {
		assert.deepEqual(normalizeSettings({ refreshSeconds: 21.6 }), { refreshSeconds: 22 });
		assert.deepEqual(normalizeSettings({ refreshSeconds: MIN_REFRESH_SECONDS - 1 }), {
			refreshSeconds: MIN_REFRESH_SECONDS,
		});
		assert.deepEqual(normalizeSettings({ refreshSeconds: MAX_REFRESH_SECONDS + 1 }), {
			refreshSeconds: MAX_REFRESH_SECONDS,
		});
	});

	test("accepts the numeric strings emitted by a property inspector", () => {
		assert.deepEqual(normalizeSettings({ refreshSeconds: "45" } as unknown as { refreshSeconds: number }), {
			refreshSeconds: 45,
		});
	});
});
