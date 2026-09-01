const ACTION_UUID = "com.beastyrabbit.t3-code-status.overview";
const DEFAULT_REFRESH_SECONDS = 60;
const MIN_REFRESH_SECONDS = 5;
const MAX_REFRESH_SECONDS = 300;
const SETTINGS_VERSION = 1;
const MAX_ACTION_INFO_CODE_UNITS = 64 * 1024;
const MAX_MESSAGE_CODE_UNITS = 64 * 1024;
const MAX_CONTEXT_CODE_UNITS = 256;
const MESSAGE_RATE_WINDOW_MS = 1_000;
const MAX_MESSAGES_PER_WINDOW = 60;

let websocket;
let inspectorContext = "";
let actionContext = "";
let socketReady = false;
let protocolFailed = false;
let connectionErrorShown = false;
let messageWindowStartedAt = 0;
let messagesInWindow = 0;

const elements = {};

function connectElgatoStreamDeckSocket(
	inPort,
	inPropertyInspectorUUID,
	inRegisterEvent,
	inInfo,
	inActionInfo,
) {
	void inInfo;
	cacheElements();
	protocolFailed = false;
	connectionErrorShown = false;
	messageWindowStartedAt = Date.now();
	messagesInWindow = 0;

	let actionInfo;
	if (typeof inActionInfo !== "string" || inActionInfo.length > MAX_ACTION_INFO_CODE_UNITS) {
		showInitializationError("OpenDeck sent invalid or oversized action data.");
		return;
	}
	try {
		actionInfo = JSON.parse(inActionInfo);
	} catch {
		showInitializationError("OpenDeck sent invalid action data.");
		return;
	}
	if (!actionInfo || typeof actionInfo !== "object" || Array.isArray(actionInfo)) {
		showInitializationError("OpenDeck sent invalid action data.");
		return;
	}

	if (!isBoundedContext(inPropertyInspectorUUID)) {
		showInitializationError("OpenDeck sent an invalid settings context.");
		return;
	}
	inspectorContext = inPropertyInspectorUUID;
	actionContext = isBoundedContext(actionInfo.context) ? actionInfo.context : inPropertyInspectorUUID;
	setSettingsEnabled(true);
	applySettings(actionInfo.payload?.settings);
	bindControls();
	setBusy(true);

	websocket = new WebSocket(`ws://localhost:${inPort}`);
	websocket.addEventListener("open", () => {
		socketReady = true;
		setSettingsEnabled(true);
		websocket.send(
			JSON.stringify({
				event: inRegisterEvent,
				uuid: inspectorContext,
			}),
		);
		sendToPlugin({ command: "getConnectionStatus" });
	});

	websocket.addEventListener("message", handleSocketMessage);
	websocket.addEventListener("error", () => {
		connectionErrorShown = true;
		showConnectionError("OpenDeck could not connect this settings panel to the plugin.");
	});
	websocket.addEventListener("close", () => {
		socketReady = false;
		setSettingsEnabled(false);
		if (protocolFailed || connectionErrorShown) return;
		showConnectionError("The connection to OpenDeck was closed.");
	});
}

function cacheElements() {
	elements.statusCard = document.querySelector(".status-card");
	elements.statusDial = document.getElementById("status-dial");
	elements.statusLight = document.getElementById("status-light");
	elements.connectionState = document.getElementById("connection-state");
	elements.connectionDetail = document.getElementById("connection-detail");
	elements.errorMessage = document.getElementById("error-message");
	elements.refreshInput = document.getElementById("refresh-seconds");
	elements.refreshNote = document.getElementById("refresh-note");
}

function bindControls() {
	elements.refreshInput.addEventListener("change", saveRefreshInterval);
}

function setSettingsEnabled(enabled) {
	elements.refreshInput.disabled = !enabled;
}

function applySettings(settings) {
	const refreshSeconds = normalizeRefreshSeconds(settings?.refreshSeconds);
	elements.refreshInput.value = String(refreshSeconds);
}

function normalizeRefreshSeconds(value) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_REFRESH_SECONDS;
	return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(parsed)));
}

function saveRefreshInterval() {
	const entered = Number(elements.refreshInput.value);
	const refreshSeconds = normalizeRefreshSeconds(elements.refreshInput.value);
	elements.refreshInput.value = String(refreshSeconds);
	const sent = sendSocketMessage({
		event: "setSettings",
		context: actionContext,
		payload: { refreshSeconds, settingsVersion: SETTINGS_VERSION },
	});
	if (!sent) {
		elements.refreshNote.textContent = "Interval not saved. Check the connection to OpenDeck.";
		return;
	}
	const wasAdjusted = !Number.isFinite(entered) || entered !== refreshSeconds;
	elements.refreshNote.textContent = wasAdjusted
		? `Adjusted to ${refreshSeconds} seconds. Choose a value from 5 to 300.`
		: `Refresh set to ${refreshSeconds} seconds. Press the key to refresh immediately.`;
}

function sendToPlugin(payload) {
	sendSocketMessage({
		action: ACTION_UUID,
		event: "sendToPlugin",
		context: actionContext,
		payload,
	});
}

function sendSocketMessage(message) {
	if (!socketReady || websocket?.readyState !== WebSocket.OPEN) {
		showConnectionError("The settings panel is not connected to OpenDeck yet.");
		return false;
	}
	try {
		websocket.send(JSON.stringify(message));
		return true;
	} catch {
		showConnectionError("OpenDeck could not save the setting.");
		return false;
	}
}

function handleSocketMessage(event) {
	if (protocolFailed) return;
	const raw = event?.data;
	if (typeof raw !== "string" || raw.length > MAX_MESSAGE_CODE_UNITS) {
		failProtocol("OpenDeck sent an oversized or unsupported settings message.");
		return;
	}
	if (!acceptMessageAt(Date.now())) {
		failProtocol("OpenDeck sent settings messages too quickly.");
		return;
	}
	let message;
	try {
		message = JSON.parse(raw);
	} catch {
		return;
	}
	if (!message || typeof message !== "object" || Array.isArray(message)) return;

	if (message.event === "didReceiveSettings") {
		applySettings(message.payload?.settings);
		return;
	}

	if (message.event !== "sendToPropertyInspector" || message.payload?.type !== "connectionStatus") return;
	renderConnectionStatus(message.payload);
}

function acceptMessageAt(now) {
	if (now < messageWindowStartedAt || now - messageWindowStartedAt >= MESSAGE_RATE_WINDOW_MS) {
		messageWindowStartedAt = now;
		messagesInWindow = 0;
	}
	messagesInWindow += 1;
	return messagesInWindow <= MAX_MESSAGES_PER_WINDOW;
}

function failProtocol(message) {
	if (protocolFailed) return;
	protocolFailed = true;
	socketReady = false;
	setSettingsEnabled(false);
	try {
		websocket?.close(1009, "Settings input limit exceeded");
	} catch {
		// The bounded local error below is sufficient if the socket is already gone.
	}
	showConnectionError(message);
}

function isBoundedContext(value) {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_CONTEXT_CODE_UNITS;
}

function renderConnectionStatus(payload) {
	const status = normalizeConnectionStatus(payload.status);
	const errorCode = typeof payload.error === "string" ? payload.error.trim() : "";
	const hasError = errorCode.length > 0;
	setBusy(Boolean(payload.busy));

	if (hasError) {
		setVisualState("error");
		showLocalError(localizeRuntimeError(errorCode));
	} else {
		clearError();
		setVisualState(status.state);
	}

	if (payload.busy) {
		elements.connectionState.textContent = busyLabel();
		elements.connectionDetail.textContent = "Reading the local T3 cache.";
		return;
	}
	if (hasError) {
		elements.connectionState.textContent = runtimeErrorLabel(errorCode);
		elements.connectionDetail.textContent = runtimeErrorDetail(errorCode);
		return;
	}

	switch (status.state) {
		case "connected":
			elements.connectionState.textContent = "Connected";
			elements.connectionDetail.textContent = connectedDetail(status);
			break;
		default:
			elements.connectionState.textContent = "T3 Code offline";
			elements.connectionDetail.textContent =
				"Start T3 Code. The plugin will then read its local thread cache.";
	}
}

function runtimeErrorLabel(code) {
	switch (code) {
		case "offline":
			return "T3 Code offline";
		case "cache-unavailable":
			return "Cache unavailable";
		case "invalid-response":
			return "Cache incompatible";
		default:
			return "Cache read failed";
	}
}

function runtimeErrorDetail(code) {
	return code === "offline"
		? "Start T3 Code. The plugin will then read its local thread cache."
		: "Thread status cannot update until the local cache is available.";
}

function localizeRuntimeError(code) {
	switch (code) {
		case "offline":
			return "T3 Code is not running or its local thread cache is unavailable.";
		case "cache-unavailable":
			return "The local T3 thread cache could not be opened.";
		case "invalid-response":
			return "The local T3 thread cache contains unexpected data. Update T3 Code and try again.";
		default:
			return "The local T3 thread cache could not be read.";
	}
}

function normalizeConnectionStatus(status) {
	if (status && typeof status === "object") {
		const state = status.state === "connected" ? "connected" : "offline";
		const environments = Number(status.environments);
		return {
			state,
			origin: typeof status.origin === "string" ? status.origin : "",
			environments: Number.isFinite(environments) ? Math.max(0, Math.trunc(environments)) : 0,
		};
	}
	return { state: "offline", origin: "", environments: 0 };
}

function connectedDetail(status) {
	const environmentLabel =
		status.environments === 1 ? "1 Environment" : `${status.environments} Environments`;
	return `${environmentLabel} · local cache · no sign-in`;
}

function setBusy(busy) {
	elements.statusDial.classList.toggle("is-busy", busy);
}

function busyLabel() {
	return "Reading cache";
}

function setVisualState(state) {
	const visualState = state === "connected" ? "connected" : state === "error" ? "error" : "offline";
	elements.statusCard.dataset.state = visualState;
	elements.statusDial.dataset.state = visualState;
	elements.statusLight.dataset.state = visualState;
}

function showLocalError(message) {
	elements.errorMessage.textContent = message;
	elements.errorMessage.hidden = false;
	setVisualState("error");
}

function showConnectionError(message) {
	socketReady = false;
	setSettingsEnabled(false);
	setBusy(false);
	elements.connectionState.textContent = "OpenDeck disconnected";
	elements.connectionDetail.textContent = "Close and reopen this settings panel after OpenDeck reconnects.";
	showLocalError(message);
}

function showInitializationError(message) {
	setBusy(false);
	setSettingsEnabled(false);
	elements.connectionState.textContent = "Settings unavailable";
	elements.connectionDetail.textContent =
		"Close and reopen this settings panel. If the problem continues, restart OpenDeck.";
	showLocalError(message);
}

function clearError() {
	elements.errorMessage.textContent = "";
	elements.errorMessage.hidden = true;
}

window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
