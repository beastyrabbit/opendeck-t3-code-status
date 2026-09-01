import {
	isValidOpenDeckContext,
	MAX_OPENDECK_LIVE_CONTEXTS,
	type OpenDeckConnection,
	type OpenDeckEvent,
} from "./opendeck.js";
import { getAccessibleTitle, renderDashboard } from "./render.js";
import { T3ClientError, type T3ClientSnapshot } from "./t3-client.js";
import {
	ACTION_UUID,
	type ConnectionStatus,
	type DashboardModel,
	DEFAULT_REFRESH_SECONDS,
	type NormalizedSettings,
	normalizeSettings,
	SETTINGS_VERSION,
} from "./types.js";

const ANIMATION_INTERVAL_MS = 1_000;
const CONNECTION_STATUS_CACHE_MS = 1_000;
const COMMAND_BURST_WINDOW_MS = 250;
const LEGACY_REFRESH_SECONDS = 15;
const RING_PROGRESS_STEPS = 20;

export interface T3StatusClient {
	getConnectionStatus(): Promise<ConnectionStatus>;
	getSnapshot(): Promise<T3ClientSnapshot>;
}

export interface T3CodeControllerOptions {
	animationIntervalMs?: number;
	now?: () => number;
}

interface VisibleContext {
	context: string;
	cycleStartedAt: number;
	lastRenderedModel?: DashboardModel;
	lastRenderedProgressStep?: number;
	lastRenderedTitle?: string;
	model: DashboardModel;
	settings: NormalizedSettings;
}

interface ConnectionStatusMessage {
	busy: boolean;
	error?: string;
	status: ConnectionStatus;
	type: "connectionStatus";
}

export class T3CodeController {
	private readonly animationIntervalMs: number;
	private readonly inspectorContexts = new Set<string>();
	private readonly lastForcedRefreshAt = new Map<string, number>();
	private readonly lastInspectorStatusRequestAt = new Map<string, number>();
	private readonly now: () => number;
	private readonly pendingConnectionStatusContexts = new Set<string>();
	private readonly pendingRefresh = new Set<string>();
	private readonly refreshAfterInFlight = new Set<string>();
	private readonly visibleContexts = new Map<string, VisibleContext>();

	private animationTimer?: NodeJS.Timeout;
	private connectionStatusKnown = false;
	private connectionStatusInFlight?: Promise<{ error?: string; status: ConnectionStatus }>;
	private connectionStatusReportInFlight?: Promise<void>;
	private connectionStatusReadAt = 0;
	private disposed = false;
	private lastConnectionError?: string;
	private lastConnectionStatus: ConnectionStatus = { state: "offline" };
	private refreshInFlight?: Promise<void>;

	constructor(
		private readonly host: OpenDeckConnection,
		private readonly client: T3StatusClient,
		options: T3CodeControllerOptions = {},
	) {
		this.animationIntervalMs = options.animationIntervalMs ?? ANIMATION_INTERVAL_MS;
		this.now = options.now ?? Date.now;
	}

	handle(event: OpenDeckEvent): void {
		if (this.disposed || event.action !== ACTION_UUID) return;
		switch (event.event) {
			case "willAppear":
				this.willAppear(event);
				break;
			case "willDisappear":
				this.willDisappear(event.context);
				break;
			case "didReceiveSettings":
				this.didReceiveSettings(event);
				break;
			case "keyUp":
				this.handleForcedRefresh(event.context);
				break;
			case "propertyInspectorDidAppear":
				this.trackInspectorContext(event.context);
				break;
			case "propertyInspectorDidDisappear":
				this.forgetInspectorContext(event.context);
				break;
			case "sendToPlugin":
				this.handleInspectorCommand(event);
				break;
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationTimer = undefined;
		this.pendingRefresh.clear();
		this.refreshAfterInFlight.clear();
		this.pendingConnectionStatusContexts.clear();
		this.visibleContexts.clear();
		this.inspectorContexts.clear();
		this.lastForcedRefreshAt.clear();
		this.lastInspectorStatusRequestAt.clear();
		await Promise.allSettled([
			this.refreshInFlight,
			this.connectionStatusInFlight,
			this.connectionStatusReportInFlight,
		]);
	}

	private willAppear(event: OpenDeckEvent): void {
		if (!event.context || !this.canTrackContext(event.context)) return;
		const now = this.now();
		const receivedSettings = readSettings(event.payload);
		const settings = migrateSettings(receivedSettings);
		this.visibleContexts.set(event.context, {
			context: event.context,
			cycleStartedAt: now,
			model: { kind: "loading" },
			settings: normalizeSettings(settings),
		});
		if (settings.settingsVersion !== receivedSettings?.settingsVersion) {
			this.host.setSettings(event.context, settings);
		}
		this.renderContext(event.context, now);
		this.startAnimation();
		this.scheduleRefresh([event.context]);
	}

	private willDisappear(context: string | undefined): void {
		if (!context) return;
		this.visibleContexts.delete(context);
		this.pendingRefresh.delete(context);
		this.refreshAfterInFlight.delete(context);
		this.inspectorContexts.delete(context);
		this.pendingConnectionStatusContexts.delete(context);
		this.lastForcedRefreshAt.delete(context);
		this.lastInspectorStatusRequestAt.delete(context);
		this.host.forgetContext(context);
		if (this.visibleContexts.size === 0) this.stopAnimation();
	}

	private didReceiveSettings(event: OpenDeckEvent): void {
		if (!event.context) return;
		const visible = this.visibleContexts.get(event.context);
		if (!visible) return;
		visible.settings = normalizeSettings(migrateSettings(readSettings(event.payload)));
		const now = this.now();
		this.renderContext(event.context, now);
		if (this.isDue(visible, now)) this.scheduleRefresh([event.context]);
	}

	private canTrackContext(context: string): boolean {
		if (!isValidOpenDeckContext(context)) return false;
		if (this.visibleContexts.has(context) || this.inspectorContexts.has(context)) return true;
		let trackedContexts = this.visibleContexts.size;
		for (const inspectorContext of this.inspectorContexts) {
			if (!this.visibleContexts.has(inspectorContext)) trackedContexts += 1;
		}
		return trackedContexts < MAX_OPENDECK_LIVE_CONTEXTS;
	}

	private trackInspectorContext(context: string | undefined): boolean {
		if (!context || !this.canTrackContext(context)) return false;
		this.inspectorContexts.add(context);
		return true;
	}

	private forgetInspectorContext(context: string | undefined): void {
		if (!context) return;
		this.inspectorContexts.delete(context);
		this.pendingConnectionStatusContexts.delete(context);
		this.lastInspectorStatusRequestAt.delete(context);
	}

	private handleForcedRefresh(context: string | undefined): void {
		if (!context || !this.visibleContexts.has(context)) return;
		if (this.refreshInFlight && this.refreshAfterInFlight.has(context)) return;
		const now = this.now();
		const lastRefresh = this.lastForcedRefreshAt.get(context);
		if (lastRefresh !== undefined && now - lastRefresh < COMMAND_BURST_WINDOW_MS) return;
		this.lastForcedRefreshAt.set(context, now);
		this.scheduleRefresh([context], true);
	}

	private startAnimation(): void {
		if (this.animationTimer || this.disposed) return;
		this.animationTimer = setInterval(() => this.tick(), this.animationIntervalMs);
		this.animationTimer.unref();
	}

	private stopAnimation(): void {
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationTimer = undefined;
	}

	private tick(): void {
		if (this.disposed || this.visibleContexts.size === 0) return;
		const now = this.now();
		const due: string[] = [];
		for (const visible of this.visibleContexts.values()) {
			this.renderContext(visible.context, now);
			if (this.isDue(visible, now)) due.push(visible.context);
		}
		if (due.length > 0) this.scheduleRefresh(due);
	}

	private isDue(visible: VisibleContext, now: number): boolean {
		return now - visible.cycleStartedAt >= visible.settings.refreshSeconds * 1_000;
	}

	private renderContext(context: string, now = this.now()): void {
		const visible = this.visibleContexts.get(context);
		if (!visible) return;
		const duration = visible.settings.refreshSeconds * 1_000;
		const progress = Math.min(1, Math.max(0, (now - visible.cycleStartedAt) / duration));
		const progressStep = Math.min(RING_PROGRESS_STEPS, Math.floor(progress * RING_PROGRESS_STEPS));
		const title = getAccessibleTitle(visible.model);
		const imageChanged =
			visible.lastRenderedModel !== visible.model || visible.lastRenderedProgressStep !== progressStep;
		if (imageChanged) {
			visible.lastRenderedModel = visible.model;
			visible.lastRenderedProgressStep = progressStep;
			this.host.setImage(context, renderDashboard(visible.model, progressStep / RING_PROGRESS_STEPS));
		}
		if (visible.lastRenderedTitle !== title) {
			visible.lastRenderedTitle = title;
			this.host.setTitle(context, title);
		}
	}

	private renderAll(now = this.now()): void {
		for (const context of this.visibleContexts.keys()) this.renderContext(context, now);
	}

	private requestRefresh(contexts: Iterable<string>, forceAfterCurrent = false): Promise<void> {
		if (this.disposed) return Promise.resolve();
		for (const context of contexts) {
			if (!this.visibleContexts.has(context)) continue;
			if (forceAfterCurrent && this.refreshInFlight) this.refreshAfterInFlight.add(context);
			else this.pendingRefresh.add(context);
		}
		if (this.pendingRefresh.size === 0) return this.refreshInFlight ?? Promise.resolve();
		if (!this.refreshInFlight) {
			const refresh = this.drainRefreshes();
			this.refreshInFlight = refresh
				.finally(() => {
					this.refreshInFlight = undefined;
					this.promoteForcedRefreshes();
					if (!this.disposed && this.pendingRefresh.size > 0) {
						this.scheduleRefresh([]);
					}
				})
				.catch(() => undefined);
		}
		return this.refreshInFlight;
	}

	private async drainRefreshes(): Promise<void> {
		while (!this.disposed && this.pendingRefresh.size > 0) {
			const targets = new Set(this.pendingRefresh);
			this.pendingRefresh.clear();
			let model: DashboardModel;
			try {
				const snapshot = await this.client.getSnapshot();
				model = { kind: "ready", refreshedAt: this.now(), summary: snapshot.summary };
				this.rememberConnectionStatus(snapshot.connectionStatus);
				this.broadcastConnectionStatus(snapshot.connectionStatus, false);
			} catch (error) {
				model = modelForClientError(error);
				const code = clientErrorCode(error);
				if (code === "offline") this.rememberConnectionStatus({ state: "offline" });
				else this.rememberConnectionStatus(this.lastConnectionStatus, code);
				this.broadcastConnectionStatus(this.lastConnectionStatus, false, this.lastConnectionError);
			}

			for (const context of this.pendingRefresh) targets.add(context);
			this.pendingRefresh.clear();
			this.promoteForcedRefreshes();
			const completedAt = this.now();
			const completedModel = model.kind === "ready" ? { ...model, refreshedAt: completedAt } : model;
			for (const visible of this.visibleContexts.values()) {
				visible.model = completedModel;
				if (!targets.has(visible.context)) continue;
				visible.cycleStartedAt = completedAt;
			}
			this.renderAll(completedAt);
		}
	}

	private promoteForcedRefreshes(): void {
		for (const context of this.refreshAfterInFlight) {
			if (this.visibleContexts.has(context)) this.pendingRefresh.add(context);
		}
		this.refreshAfterInFlight.clear();
	}

	private scheduleRefresh(contexts: Iterable<string>, forceAfterCurrent = false): void {
		void this.requestRefresh(contexts, forceAfterCurrent);
	}

	private handleInspectorCommand(event: OpenDeckEvent): void {
		if (!event.context || !isRecord(event.payload) || typeof event.payload.command !== "string") return;
		switch (event.payload.command) {
			case "getConnectionStatus": {
				if (!this.trackInspectorContext(event.context)) return;
				this.queueConnectionStatusReport(event.context);
				break;
			}
		}
	}

	private queueConnectionStatusReport(context: string): void {
		if (this.pendingConnectionStatusContexts.has(context)) return;
		const now = this.now();
		const lastRequest = this.lastInspectorStatusRequestAt.get(context);
		if (lastRequest !== undefined && now - lastRequest < COMMAND_BURST_WINDOW_MS) return;
		this.lastInspectorStatusRequestAt.set(context, now);
		this.pendingConnectionStatusContexts.add(context);
		this.startConnectionStatusReports();
	}

	private startConnectionStatusReports(): void {
		if (this.connectionStatusReportInFlight || this.disposed) return;
		const report = this.drainConnectionStatusReports().catch(() => undefined);
		this.connectionStatusReportInFlight = report.finally(() => {
			this.connectionStatusReportInFlight = undefined;
			if (!this.disposed && this.pendingConnectionStatusContexts.size > 0) {
				this.startConnectionStatusReports();
			}
		});
	}

	private async drainConnectionStatusReports(): Promise<void> {
		while (!this.disposed && this.pendingConnectionStatusContexts.size > 0) {
			const targets = new Set(this.pendingConnectionStatusContexts);
			this.pendingConnectionStatusContexts.clear();
			if (this.refreshInFlight) await this.refreshInFlight.catch(() => undefined);
			for (const context of this.pendingConnectionStatusContexts) targets.add(context);
			this.pendingConnectionStatusContexts.clear();

			const result =
				this.connectionStatusKnown && this.now() - this.connectionStatusReadAt <= CONNECTION_STATUS_CACHE_MS
					? {
							...(this.lastConnectionError ? { error: this.lastConnectionError } : {}),
							status: this.lastConnectionStatus,
						}
					: await this.coalescedConnectionStatusRead();
			for (const context of targets) {
				if (this.inspectorContexts.has(context)) {
					this.sendConnectionStatus(context, result.status, false, result.error);
				}
			}
		}
	}

	private async coalescedConnectionStatusRead(): Promise<{
		error?: string;
		status: ConnectionStatus;
	}> {
		if (this.connectionStatusInFlight) return this.connectionStatusInFlight;
		const read = this.readConnectionStatus();
		this.connectionStatusInFlight = read;
		try {
			return await read;
		} finally {
			if (this.connectionStatusInFlight === read) this.connectionStatusInFlight = undefined;
		}
	}

	private async readConnectionStatus(): Promise<{ error?: string; status: ConnectionStatus }> {
		try {
			const status = await this.client.getConnectionStatus();
			this.rememberConnectionStatus(status);
			return { status };
		} catch (error) {
			const code = clientErrorCode(error);
			if (code === "offline") this.rememberConnectionStatus({ state: "offline" });
			else this.rememberConnectionStatus(this.lastConnectionStatus, code);
			return {
				...(this.lastConnectionError ? { error: this.lastConnectionError } : {}),
				status: this.lastConnectionStatus,
			};
		}
	}

	private rememberConnectionStatus(status: ConnectionStatus, error?: string): void {
		this.connectionStatusKnown = true;
		this.connectionStatusReadAt = this.now();
		this.lastConnectionError = error;
		this.lastConnectionStatus = status;
	}

	private broadcastConnectionStatus(status: ConnectionStatus, busy: boolean, error?: string): void {
		for (const context of this.inspectorContexts) this.sendConnectionStatus(context, status, busy, error);
	}

	private sendConnectionStatus(
		context: string,
		status: ConnectionStatus,
		busy: boolean,
		error?: string,
	): void {
		if (this.disposed) return;
		const payload: ConnectionStatusMessage = {
			busy,
			status,
			type: "connectionStatus",
			...(error ? { error } : {}),
		};
		this.host.sendToPropertyInspector(ACTION_UUID, context, payload);
	}
}

function readSettings(payload: unknown): { refreshSeconds?: number; settingsVersion?: number } | undefined {
	if (!isRecord(payload) || !isRecord(payload.settings)) return undefined;
	const value = payload.settings.refreshSeconds;
	const version = payload.settings.settingsVersion;
	const refreshSeconds =
		typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
	return {
		...(refreshSeconds === undefined ? {} : { refreshSeconds }),
		...(typeof version === "number" ? { settingsVersion: version } : {}),
	};
}

function migrateSettings(settings: { refreshSeconds?: number; settingsVersion?: number } | undefined): {
	refreshSeconds: number;
	settingsVersion: number;
} {
	if (settings?.settingsVersion === SETTINGS_VERSION) {
		return { ...normalizeSettings(settings), settingsVersion: SETTINGS_VERSION };
	}
	const refreshSeconds =
		settings?.refreshSeconds === LEGACY_REFRESH_SECONDS ? DEFAULT_REFRESH_SECONDS : settings?.refreshSeconds;
	return { ...normalizeSettings({ refreshSeconds }), settingsVersion: SETTINGS_VERSION };
}

function modelForClientError(error: unknown): DashboardModel {
	if (!(error instanceof T3ClientError)) return { kind: "error" };
	switch (error.code) {
		case "offline":
			return { kind: "offline" };
		default:
			return { kind: "error" };
	}
}

function clientErrorCode(error: unknown): string {
	return error instanceof T3ClientError ? error.code : "cache-read-failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
