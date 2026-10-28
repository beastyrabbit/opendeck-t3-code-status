import {
	isValidOpenDeckContext,
	MAX_OPENDECK_LIVE_CONTEXTS,
	type OpenDeckConnection,
	type OpenDeckEvent,
} from "./opendeck.js";
import { getAccessibleTitle, isAlerting, renderKey } from "./render.js";
import { parseSshHosts } from "./ssh-pairing.js";
import { LiveConnectionError } from "./t3-protocol.js";
import { discoverTailnetHosts, isTailnetHost, sshPairingIssuer } from "./tailnet.js";
import {
	ACTION_UUID,
	ACTION_UUIDS,
	type ActionSettings,
	type ConnectionStatus,
	type DashboardModel,
	DEFAULT_REFRESH_SECONDS,
	type NormalizedSettings,
	normalizeSettings,
	OVERVIEW_ACTION_UUID,
	type RenderMode,
	SETTINGS_VERSION,
	type T3ClientSnapshot,
} from "./types.js";

const ANIMATION_INTERVAL_MS = 500;
const CONNECTION_STATUS_CACHE_MS = 1_000;
const COMMAND_BURST_WINDOW_MS = 250;
const ERROR_RETRY_INTERVAL_MS = 5_000;
const LEGACY_REFRESH_SECONDS = 15;

export interface T3StatusClient {
	subscribe?(listener: () => void): () => void;
	pair?(link: string, allowHttp: boolean): Promise<void>;
	remove?(environmentId: string): Promise<void>;
	reconnect?(): Promise<void>;
	dispose?(): Promise<void>;
	getConnectionStatus(): Promise<ConnectionStatus>;
	getSnapshot(): Promise<T3ClientSnapshot>;
}

export interface T3CodeControllerOptions {
	animationIntervalMs?: number;
	/** Creates a read-only pairing link on a host; SSH by default. */
	issuePairingLink?: (host: string) => Promise<string>;
	/** Lists hosts that run T3; Tailscale peers by default. */
	discoverHosts?: () => Promise<string[]>;
	/** Whether plain HTTP to a host is safe without the user's opt-in; true for tailnet addresses by default. */
	isEncryptedNetwork?: (hostname: string) => Promise<boolean>;
	now?: () => number;
}

interface VisibleContext {
	action: string;
	context: string;
	cycleStartedAt: number;
	lastRenderedModel?: DashboardModel;
	lastRenderedMode?: RenderMode;
	lastRenderedTheme?: NormalizedSettings["theme"];
	lastRenderedAlertPhase?: boolean;
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
	private readonly issuePairingLink: (host: string) => Promise<string>;
	private readonly discoverHosts: () => Promise<string[]>;
	private readonly isEncryptedNetwork: (hostname: string) => Promise<boolean>;
	/** Open settings panels, with the action of their key. */
	private readonly inspectorContexts = new Map<string, string>();
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
	private unsubscribe?: () => void;
	private authInFlight?: Promise<void>;
	private discoveryInFlight = false;
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
		this.issuePairingLink = options.issuePairingLink ?? sshPairingIssuer();
		this.discoverHosts = options.discoverHosts ?? (() => discoverTailnetHosts());
		this.isEncryptedNetwork = options.isEncryptedNetwork ?? ((hostname) => isTailnetHost(hostname));
		this.unsubscribe = client.subscribe?.(() => {
			if (this.disposed) return;
			this.connectionStatusKnown = false;
			this.scheduleRefresh(this.visibleContexts.keys(), true);
			for (const context of this.inspectorContexts.keys()) this.pendingConnectionStatusContexts.add(context);
			this.startConnectionStatusReports();
		});
	}

	handle(event: OpenDeckEvent): void {
		if (this.disposed || !event.action || !ACTION_UUIDS.includes(event.action)) return;
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
				this.trackInspectorContext(event.context, event.action);
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
		this.unsubscribe?.();
		await this.client.dispose?.();
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
			this.authInFlight,
		]);
	}

	private willAppear(event: OpenDeckEvent): void {
		if (!event.context || !this.canTrackContext(event.context)) return;
		const now = this.now();
		const receivedSettings = readSettings(event.payload);
		const settings = migrateSettings(receivedSettings);
		const visible: VisibleContext = {
			action: event.action ?? ACTION_UUID,
			context: event.context,
			cycleStartedAt: now,
			model: { kind: "loading" },
			settings: normalizeSettings(settings),
		};
		this.visibleContexts.set(event.context, visible);
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
		for (const inspectorContext of this.inspectorContexts.keys()) {
			if (!this.visibleContexts.has(inspectorContext)) trackedContexts += 1;
		}
		return trackedContexts < MAX_OPENDECK_LIVE_CONTEXTS;
	}

	private trackInspectorContext(context: string | undefined, action: string | undefined): boolean {
		if (!context || !this.canTrackContext(context)) return false;
		this.inspectorContexts.set(context, action ?? ACTION_UUID);
		return true;
	}

	private sendToInspector(context: string, payload: object): void {
		this.host.sendToPropertyInspector(this.inspectorContexts.get(context) ?? ACTION_UUID, context, payload);
	}

	private renderMode(visible: VisibleContext): RenderMode {
		return visible.action === OVERVIEW_ACTION_UUID ? "overview" : visible.settings.displayMode;
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
		void this.client.reconnect?.();
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
		if (this.client.subscribe) return false;
		return now - visible.cycleStartedAt >= this.refreshIntervalMs(visible);
	}

	private refreshIntervalMs(visible: VisibleContext): number {
		return visible.model.kind === "offline" || visible.model.kind === "error"
			? ERROR_RETRY_INTERVAL_MS
			: visible.settings.refreshSeconds * 1_000;
	}

	private renderContext(context: string, now = this.now()): void {
		const visible = this.visibleContexts.get(context);
		if (!visible) return;
		const { theme } = visible.settings;
		const mode = this.renderMode(visible);
		const alertPhase = isAlerting(visible.model, mode) && Math.floor(now / 500) % 2 === 0;
		const title = getAccessibleTitle(visible.model, mode);
		const imageChanged =
			visible.lastRenderedModel !== visible.model ||
			visible.lastRenderedMode !== mode ||
			visible.lastRenderedTheme !== theme ||
			visible.lastRenderedAlertPhase !== alertPhase;
		if (imageChanged) {
			visible.lastRenderedModel = visible.model;
			visible.lastRenderedMode = mode;
			visible.lastRenderedTheme = theme;
			visible.lastRenderedAlertPhase = alertPhase;
			this.host.setImage(context, renderKey(visible.model, mode, theme, alertPhase));
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
				if (this.client.subscribe)
					this.rememberConnectionStatus(await this.client.getConnectionStatus(), code);
				else if (code === "offline") this.rememberConnectionStatus({ state: "offline" });
				else this.rememberConnectionStatus(this.lastConnectionStatus, code);
				this.broadcastConnectionStatus(this.lastConnectionStatus, false, this.lastConnectionError);
			}

			for (const context of this.pendingRefresh) targets.add(context);
			this.pendingRefresh.clear();
			this.promoteForcedRefreshes();
			const completedAt = this.now();
			const completedModel = model.kind === "ready" ? { ...model, refreshedAt: completedAt } : model;
			for (const visible of this.visibleContexts.values()) {
				const wasRecovering = visible.model.kind === "offline" || visible.model.kind === "error";
				visible.model = completedModel;
				if (targets.has(visible.context) || completedModel.kind !== "ready" || wasRecovering) {
					visible.cycleStartedAt = completedAt;
				}
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
			case "pair":
			case "pairSsh":
			case "removeConnection": {
				if (!this.trackInspectorContext(event.context, event.action)) return;
				if (this.authInFlight) {
					this.sendToInspector(event.context, {
						type: "pairingResult",
						error: "busy",
					});
					return;
				}
				const payload = event.payload;
				const context = event.context;
				if (
					payload.command === "pair" &&
					(typeof payload.link !== "string" || payload.link.length > 16_384 || !this.client.pair)
				)
					return;
				if (
					payload.command === "pairSsh" &&
					(typeof payload.hosts !== "string" || payload.hosts.length > 4096 || !this.client.pair)
				)
					return;
				if (
					payload.command === "removeConnection" &&
					(typeof payload.environmentId !== "string" ||
						payload.environmentId.length > 1024 ||
						!this.client.remove)
				)
					return;
				this.broadcastConnectionStatus(this.lastConnectionStatus, true);
				this.authInFlight = (async () => {
					let error: string | undefined;
					let hosts: { host: string; error?: string }[] | undefined;
					try {
						if (payload.command === "pair")
							await this.client.pair?.(payload.link as string, payload.allowHttp === true);
						else if (payload.command === "pairSsh")
							hosts = await this.pairOverSsh(payload.hosts as string, payload.allowHttp === true);
						else await this.client.remove?.(payload.environmentId as string);
					} catch (cause) {
						error = clientErrorCode(cause);
					}
					const status = await this.client.getConnectionStatus();
					this.rememberConnectionStatus(status);
					this.broadcastConnectionStatus(status, false);
					if (!this.disposed)
						this.sendToInspector(context, {
							type: "pairingResult",
							...(error ? { error } : {}),
							...(hosts ? { hosts } : {}),
						});
					this.scheduleRefresh(this.visibleContexts.keys(), true);
				})()
					.catch(() => undefined)
					.finally(() => {
						this.authInFlight = undefined;
					});
				break;
			}
			case "discoverHosts": {
				if (!this.trackInspectorContext(event.context, event.action) || this.discoveryInFlight) return;
				const context = event.context;
				this.discoveryInFlight = true;
				void this.discoverHosts()
					.catch(() => [])
					.then((hosts) => {
						if (!this.disposed) this.sendToInspector(context, { type: "discoveryResult", hosts });
					})
					.finally(() => {
						this.discoveryInFlight = false;
					});
				break;
			}
			case "getConnectionStatus": {
				if (!this.trackInspectorContext(event.context, event.action)) return;
				this.queueConnectionStatusReport(event.context);
				break;
			}
		}
	}

	/** Creates pairing links on every host at once, then pairs them one by one. */
	private async pairOverSsh(list: string, allowHttp: boolean): Promise<{ host: string; error?: string }[]> {
		const hosts = parseSshHosts(list);
		const links = await Promise.allSettled(hosts.map((host) => this.issuePairingLink(host)));
		const results: { host: string; error?: string }[] = [];
		for (const [index, host] of hosts.entries()) {
			const link = links[index];
			try {
				if (link?.status !== "fulfilled") throw link?.reason;
				if (this.disposed) break;
				const hostname = host.split(":")[0] ?? host;
				await this.client.pair?.(link.value, allowHttp || (await this.isEncryptedNetwork(hostname)));
				results.push({ host });
			} catch (cause) {
				results.push({ host, error: clientErrorCode(cause) });
			}
		}
		return results;
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
		for (const context of this.inspectorContexts.keys())
			this.sendConnectionStatus(context, status, busy, error);
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
		this.sendToInspector(context, payload);
	}
}

function readSettings(payload: unknown): ActionSettings | undefined {
	if (!isRecord(payload) || !isRecord(payload.settings)) return undefined;
	const value = payload.settings.refreshSeconds;
	const version = payload.settings.settingsVersion;
	const refreshSeconds =
		typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
	const { displayMode, theme } = normalizeSettings({
		displayMode: payload.settings.displayMode as ActionSettings["displayMode"],
		theme: payload.settings.theme as ActionSettings["theme"],
	});
	return {
		displayMode,
		theme,
		...(refreshSeconds === undefined ? {} : { refreshSeconds }),
		...(typeof version === "number" ? { settingsVersion: version } : {}),
	};
}

function migrateSettings(
	settings: ActionSettings | undefined,
): NormalizedSettings & { settingsVersion: number } {
	if (settings?.settingsVersion === SETTINGS_VERSION) {
		return { ...normalizeSettings(settings), settingsVersion: SETTINGS_VERSION };
	}
	const refreshSeconds =
		settings?.refreshSeconds === LEGACY_REFRESH_SECONDS ? DEFAULT_REFRESH_SECONDS : settings?.refreshSeconds;
	return { ...normalizeSettings({ ...settings, refreshSeconds }), settingsVersion: SETTINGS_VERSION };
}

function modelForClientError(error: unknown): DashboardModel {
	if (!(error instanceof LiveConnectionError)) return { kind: "error" };
	if (error.code === "pairing-required") return { kind: "pairing" };
	if (error.code === "authorization-required") return { kind: "reauth" };
	if (error.code === "unsupported-version") return { kind: "unsupported" };
	if (error.code === "connecting") return { kind: "loading" };
	return { kind: error.code === "offline" ? "offline" : "error" };
}

function clientErrorCode(error: unknown): string {
	return error instanceof LiveConnectionError ? error.code : "invalid-response";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
