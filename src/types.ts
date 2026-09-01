export const PLUGIN_UUID = "com.beastyrabbit.t3-code-status";
export const ACTION_UUID = `${PLUGIN_UUID}.overview`;
export const DEFAULT_REFRESH_SECONDS = 60;
export const MIN_REFRESH_SECONDS = 5;
export const MAX_REFRESH_SECONDS = 300;
export const SETTINGS_VERSION = 1;

export interface ActionSettings {
	refreshSeconds?: number;
	settingsVersion?: number;
}

export interface NormalizedSettings {
	refreshSeconds: number;
}

export type T3SessionStatus =
	| "idle"
	| "starting"
	| "running"
	| "ready"
	| "interrupted"
	| "stopped"
	| "error"
	| string;

export interface T3ThreadSession {
	status: T3SessionStatus;
	updatedAt?: string;
}

export interface T3LatestTurn {
	state: "running" | "interrupted" | "completed" | "error";
	requestedAt?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
}

export interface T3ThreadShell {
	id: string;
	interactionMode: "default" | "plan";
	archivedAt: string | null;
	createdAt?: string | null;
	settledOverride: "settled" | "active" | null;
	settledAt: string | null;
	latestUserMessageAt?: string | null;
	snoozedAt?: string | null;
	snoozedUntil?: string | null;
	hasPendingApprovals: boolean;
	hasPendingUserInput: boolean;
	hasActionableProposedPlan: boolean;
	backgroundLiveness?: "working" | "monitoring" | null;
	latestTurn: T3LatestTurn | null;
	session: T3ThreadSession | null;
}

export interface T3ShellSnapshot {
	snapshotSequence: number;
	threads: T3ThreadShell[];
	updatedAt: string;
}

export type ThreadState =
	| "approval"
	| "input"
	| "failed"
	| "starting"
	| "working"
	| "monitoring"
	| "plan"
	| "waiting";

export interface ThreadSummary {
	total: number;
	running: number;
	attention: number;
	approval: number;
	input: number;
	failed: number;
	starting: number;
	working: number;
	monitoring: number;
	plan: number;
	waiting: number;
}

export type DashboardModel =
	| { kind: "loading" }
	| { kind: "ready"; summary: ThreadSummary; refreshedAt: number }
	| { kind: "offline" }
	| { kind: "error" };

export type ConnectionStatus =
	| { state: "connected"; origin: string; environments: number }
	| { state: "offline"; origin?: string };

export function normalizeSettings(settings: ActionSettings | undefined): NormalizedSettings {
	const candidate = Number(settings?.refreshSeconds);
	const refreshSeconds = Number.isFinite(candidate)
		? Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(candidate)))
		: DEFAULT_REFRESH_SECONDS;
	return { refreshSeconds };
}
