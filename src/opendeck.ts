import WebSocket, { type RawData } from "ws";

const RECONNECT_MAX_MS = 10_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_RESET_MS = 5_000;
const WEBSOCKET_MAX_PAYLOAD = 1024 * 1024;
const WEBSOCKET_MAX_BUFFERED_BYTES = 256 * 1024;
const STATE_FLUSH_RETRY_MS = 50;

// Contexts are opaque host identifiers, but real OpenDeck values are short UUID-like
// strings. These limits leave room for many decks while bounding retained hostile input.
export const MAX_OPENDECK_CONTEXT_CODE_UNITS = 256;
export const MAX_OPENDECK_LIVE_CONTEXTS = 128;
export const MAX_OPENDECK_PENDING_HANDLERS = 64;
export const MAX_OPENDECK_TITLE_CODE_UNITS = 256;

export interface OpenDeckLaunchArguments {
	info: unknown;
	pluginUUID: string;
	port: number;
	registerEvent: string;
}

export interface OpenDeckEvent {
	action?: string;
	context?: string;
	device?: string;
	event: string;
	payload?: unknown;
}

export type OpenDeckEventHandler = (event: OpenDeckEvent) => Promise<void> | void;

export interface OpenDeckConnection {
	forgetContext(context: string): void;
	sendToPropertyInspector(action: string, context: string, payload: object): void;
	setImage(context: string, image: string): void;
	setSettings(context: string, settings: object): void;
	setTitle(context: string, title: string): void;
}

export function canQueueWebSocketMessage(bufferedAmount: number, messageBytes: number): boolean {
	return (
		Number.isSafeInteger(bufferedAmount) &&
		Number.isSafeInteger(messageBytes) &&
		bufferedAmount >= 0 &&
		messageBytes >= 0 &&
		messageBytes <= WEBSOCKET_MAX_BUFFERED_BYTES &&
		bufferedAmount <= WEBSOCKET_MAX_BUFFERED_BYTES - messageBytes
	);
}

export function isValidOpenDeckContext(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_OPENDECK_CONTEXT_CODE_UNITS;
}

export function isValidOpenDeckTitle(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_OPENDECK_TITLE_CODE_UNITS;
}

export class OpenDeckHost implements OpenDeckConnection {
	readonly launchArguments: OpenDeckLaunchArguments;

	private connectPromise?: Promise<void>;
	private connectResolve?: () => void;
	private desiredContexts = new Set<string>();
	private desiredImages = new Map<string, string>();
	private desiredTitles = new Map<string, string>();
	private eventHandler?: OpenDeckEventHandler;
	private pendingEventHandlers = 0;
	private reconnectAttempts = 0;
	private reconnectResetTimer?: NodeJS.Timeout;
	private reconnectTimer?: NodeJS.Timeout;
	private sentImages = new Map<string, string>();
	private sentTitles = new Map<string, string>();
	private socket?: WebSocket;
	private stateFlushTimer?: NodeJS.Timeout;
	private started = false;
	private stopped = false;

	constructor(argumentsList = process.argv.slice(2)) {
		this.launchArguments = parseLaunchArguments(argumentsList);
	}

	onEvent(handler: OpenDeckEventHandler): void {
		this.eventHandler = handler;
	}

	connect(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = new Promise<void>((resolve) => {
			this.connectResolve = resolve;
		});
		this.started = true;
		this.openSocket();
		return this.connectPromise;
	}

	close(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.reconnectResetTimer) clearTimeout(this.reconnectResetTimer);
		if (this.stateFlushTimer) clearTimeout(this.stateFlushTimer);
		this.reconnectTimer = undefined;
		this.reconnectResetTimer = undefined;
		this.stateFlushTimer = undefined;
		this.connectResolve?.();
		this.connectResolve = undefined;

		const socket = this.socket;
		this.socket = undefined;
		if (!socket) return;
		if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Plugin stopping");
		else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
	}

	setImage(context: string, image: string): void {
		if (!this.retainContext(context)) return;
		this.desiredImages.set(context, image);
		if (this.sentImages.get(context) === image) return;
		if (
			this.send({
				context,
				event: "setImage",
				payload: { image, target: 0 },
			})
		) {
			this.sentImages.set(context, image);
		} else if (this.socket?.readyState === WebSocket.OPEN) {
			this.scheduleStateFlush();
		}
	}

	setTitle(context: string, title: string): void {
		if (!isValidOpenDeckTitle(title) || !this.retainContext(context)) return;
		this.desiredTitles.set(context, title);
		if (this.sentTitles.get(context) === title) return;
		if (
			this.send({
				context,
				event: "setTitle",
				payload: { target: 0, title },
			})
		) {
			this.sentTitles.set(context, title);
		} else if (this.socket?.readyState === WebSocket.OPEN) {
			this.scheduleStateFlush();
		}
	}

	setSettings(context: string, settings: object): void {
		if (!isValidOpenDeckContext(context)) return;
		this.send({ context, event: "setSettings", payload: settings });
	}

	forgetContext(context: string): void {
		this.desiredContexts.delete(context);
		this.desiredImages.delete(context);
		this.desiredTitles.delete(context);
		this.sentImages.delete(context);
		this.sentTitles.delete(context);
	}

	sendToPropertyInspector(action: string, context: string, payload: object): void {
		if (!isValidOpenDeckContext(context)) return;
		this.send({ action, context, event: "sendToPropertyInspector", payload });
	}

	private openSocket(): void {
		if (this.stopped) return;
		const socket = new WebSocket(`ws://127.0.0.1:${this.launchArguments.port}`, {
			handshakeTimeout: 5_000,
			maxPayload: WEBSOCKET_MAX_PAYLOAD,
		});
		this.socket = socket;

		socket.once("open", () => {
			if (this.stopped || this.socket !== socket) {
				socket.close();
				return;
			}
			this.sentImages.clear();
			this.sentTitles.clear();
			this.send({
				event: this.launchArguments.registerEvent,
				uuid: this.launchArguments.pluginUUID,
			});
			this.flushStates();
			this.reconnectResetTimer = setTimeout(() => {
				if (this.socket === socket && socket.readyState === WebSocket.OPEN) this.reconnectAttempts = 0;
				this.reconnectResetTimer = undefined;
			}, RECONNECT_RESET_MS);
			this.reconnectResetTimer.unref();
			this.connectResolve?.();
			this.connectResolve = undefined;
		});

		socket.on("message", (data, isBinary) => {
			if (!isBinary) this.receive(data);
		});
		socket.on("error", () => {
			// The close event schedules a reconnect. Do not include socket details in logs.
		});
		socket.once("close", () => {
			if (this.socket === socket) this.socket = undefined;
			if (this.reconnectResetTimer) clearTimeout(this.reconnectResetTimer);
			this.reconnectResetTimer = undefined;
			this.sentImages.clear();
			this.sentTitles.clear();
			this.scheduleReconnect();
		});
	}

	private receive(data: RawData): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (!isRecord(parsed) || typeof parsed.event !== "string") return;

		const event: OpenDeckEvent = {
			event: parsed.event,
			...(typeof parsed.action === "string" ? { action: parsed.action } : {}),
			...(isValidOpenDeckContext(parsed.context) ? { context: parsed.context } : {}),
			...(typeof parsed.device === "string" ? { device: parsed.device } : {}),
			...(Object.hasOwn(parsed, "payload") ? { payload: parsed.payload } : {}),
		};
		this.dispatchEvent(event);
	}

	private dispatchEvent(event: OpenDeckEvent): void {
		const handler = this.eventHandler;
		if (!handler || this.pendingEventHandlers >= MAX_OPENDECK_PENDING_HANDLERS) return;
		let result: Promise<void> | void;
		try {
			result = handler(event);
		} catch {
			return;
		}
		if (!result) return;
		this.pendingEventHandlers += 1;
		void Promise.resolve(result)
			.catch(() => undefined)
			.finally(() => {
				this.pendingEventHandlers -= 1;
			});
	}

	private send(message: object): boolean {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		try {
			const serialized = JSON.stringify(message);
			const messageBytes = Buffer.byteLength(serialized);
			if (!canQueueWebSocketMessage(socket.bufferedAmount, messageBytes)) return false;
			socket.send(serialized);
			return true;
		} catch {
			return false;
		}
	}

	private flushStates(): void {
		for (const [context, image] of this.desiredImages) this.setImage(context, image);
		for (const [context, title] of this.desiredTitles) this.setTitle(context, title);
	}

	private scheduleStateFlush(): void {
		if (this.stopped || this.stateFlushTimer) return;
		this.stateFlushTimer = setTimeout(() => {
			this.stateFlushTimer = undefined;
			if (this.socket?.readyState === WebSocket.OPEN) this.flushStates();
		}, STATE_FLUSH_RETRY_MS);
		this.stateFlushTimer.unref();
	}

	private retainContext(context: string): boolean {
		if (!isValidOpenDeckContext(context)) return false;
		if (!this.desiredContexts.has(context) && this.desiredContexts.size >= MAX_OPENDECK_LIVE_CONTEXTS) {
			return false;
		}
		this.desiredContexts.add(context);
		return true;
	}

	private scheduleReconnect(): void {
		if (this.stopped || !this.started || this.reconnectTimer) return;
		const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.reconnectAttempts);
		this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.openSocket();
		}, delay);
	}
}

export function parseLaunchArguments(argumentsList: string[]): OpenDeckLaunchArguments {
	const value = (name: string): string => {
		const index = argumentsList.indexOf(name);
		const result = index >= 0 ? argumentsList[index + 1] : undefined;
		if (!result) throw new Error(`Missing OpenDeck argument ${name}`);
		return result;
	};

	const rawPort = value("-port");
	if (!/^\d+$/.test(rawPort)) throw new Error("Invalid OpenDeck argument -port");
	const port = Number(rawPort);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("Invalid OpenDeck argument -port");
	}

	const rawInfo = value("-info");
	let info: unknown;
	try {
		info = JSON.parse(rawInfo);
	} catch {
		throw new Error("Invalid OpenDeck argument -info");
	}

	return {
		info,
		pluginUUID: value("-pluginUUID"),
		port,
		registerEvent: value("-registerEvent"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
