export const PLUGIN_UUID = "com.beastyrabbit.t3-code-status";
export const ACTION_UUID = `${PLUGIN_UUID}.overview`;
/** One key that shows several counts at once. */
export const OVERVIEW_ACTION_UUID = `${PLUGIN_UUID}.overview-tile`;
export const ACTION_UUIDS: readonly string[] = [ACTION_UUID, OVERVIEW_ACTION_UUID];
export const DEFAULT_REFRESH_SECONDS = 60;
export const MIN_REFRESH_SECONDS = 5;
export const MAX_REFRESH_SECONDS = 300;
export const SETTINGS_VERSION = 2;

/** What a Thread status key shows: the combined summary or a single status. */
export const DISPLAY_MODES = [
	"combined",
	"working",
	"needs",
	"approval",
	"question",
	"plan",
	"failed",
	"limit",
	"background",
	"waiting",
] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** Everything a key can draw: a Thread status key's display mode, or the Overview key. */
export type RenderMode = DisplayMode | "overview";

export const THEMES = ["counter", "pictogram", "flood", "gauge", "quad"] as const;
export type Theme = (typeof THEMES)[number];

// Display modes saved by plugin versions before 0.4.
const LEGACY_DISPLAY_MODES = new Map<string, DisplayMode>([
	["threads", "working"],
	["questions", "needs"],
]);

export interface ActionSettings {
	displayMode?: DisplayMode | "threads" | "questions";
	theme?: Theme;
	refreshSeconds?: number;
	settingsVersion?: number;
}

export interface NormalizedSettings {
	displayMode: DisplayMode;
	theme: Theme;
	refreshSeconds: number;
}

/** T3 orchestration V2 run status, or "idle" before the first run. Unknown future values are kept. */
export type T3RunStatus =
	| "idle"
	| "preparing"
	| "queued"
	| "starting"
	| "running"
	| "waiting"
	| "completed"
	| "interrupted"
	| "failed"
	| "cancelled"
	| "rolled_back"
	| (string & {});

export interface T3PendingRequest {
	/** "user_input", "auth_refresh", or a provider approval kind. */
	kind: string;
	/** False for async questions the run keeps working past. Absent from older servers. */
	blocking?: boolean;
}

export interface T3BackgroundTask {
	kind: string;
	awaited: boolean;
}

/** The status fields of a V2 `OrchestrationV2ThreadShell`, never conversation or file data. */
export interface T3ThreadShell {
	id: string;
	parentThreadId: string | null;
	relationshipToParent: "fork" | "subagent" | null;
	creationSource: string | null;
	interactionMode: "default" | "plan";
	status: T3RunStatus;
	/** Undefined from servers that predate it; null when no activity run exists. */
	activityRunStatus?: T3RunStatus | null;
	latestRunId: string | null;
	latestRunCompletedAt: string | null;
	activeProviderThreadId: string | null;
	pendingRuntimeRequest: T3PendingRequest | null;
	pendingGuestMessageCount: number;
	hasActionableProposedPlan: boolean;
	pendingBackgroundTasks: T3BackgroundTask[];
	limitRecovery: boolean;
	/** The latest failure was a provider usage limit (T3's `lastErrorClass: "usage_limit"`). */
	usageLimitFailure: boolean;
	updatedAt: string;
	archivedAt: string | null;
	deletedAt: string | null;
	settledOverride: "settled" | "active" | null;
	snoozedAt: string | null;
	snoozedUntil: string | null;
	/** When the user last opened the thread; absent from servers that predate it. */
	lastVisitedAt?: string | null;
	/** True while the run waits on another thread, such as a subagent. */
	blockedOnThreadWait?: boolean;
}

export interface T3ShellSnapshot {
	snapshotSequence: number;
	threads: T3ThreadShell[];
	updatedAt: string;
}

export type ThreadState =
	| "approval"
	| "input"
	| "plan"
	| "limited"
	| "failed"
	| "starting"
	| "working"
	| "monitoring"
	| "waiting";

export interface ThreadSummary {
	total: number;
	running: number;
	attention: number;
	approval: number;
	input: number;
	plan: number;
	limited: number;
	failed: number;
	starting: number;
	working: number;
	monitoring: number;
	waiting: number;
	/** Open threads with background tasks; these also count in their own state. */
	background: number;
	/** Running threads that only wait on another thread or a background task. */
	blocked: number;
	/** Idle threads whose latest run finished after the user last opened them. */
	unseen: number;
}

export interface T3ClientSnapshot {
	connectionStatus: ConnectionStatus;
	summary: ThreadSummary;
}

export type DashboardModel =
	| { kind: "loading" }
	| { kind: "ready"; summary: ThreadSummary; refreshedAt: number }
	| { kind: "offline" }
	| { kind: "pairing" }
	| { kind: "reauth" }
	| { kind: "unsupported" }
	| { kind: "error" };

export interface EnvironmentStatus {
	environmentId: string;
	label: string;
	origin: string;
	expiresAt: number;
	state: "connected" | "connecting" | "offline" | "authorization-required";
	error?: string;
	/** The machine name a Tailscale pairing was made with; its origin is then the Tailscale address. */
	host?: string;
}

export type ConnectionStatus =
	| { state: "connected"; origin: string; environments: number }
	| { state: "offline"; origin?: string }
	| {
			state: "connected" | "connecting" | "offline" | "authorization-required" | "pairing-required" | "error";
			origin?: string;
			environments?: number;
			connections: EnvironmentStatus[];
			error?: string;
	  };

export function normalizeSettings(settings: ActionSettings | undefined): NormalizedSettings {
	const candidate = Number(settings?.refreshSeconds);
	const refreshSeconds = Number.isFinite(candidate)
		? Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(candidate)))
		: DEFAULT_REFRESH_SECONDS;
	const mode = String(settings?.displayMode);
	const displayMode =
		LEGACY_DISPLAY_MODES.get(mode) ?? DISPLAY_MODES.find((candidate) => candidate === mode) ?? "combined";
	const theme = THEMES.find((candidate) => candidate === settings?.theme) ?? "counter";
	return { displayMode, theme, refreshSeconds };
}
