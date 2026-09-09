const ACTION_UUID = "com.beastyrabbit.t3-code-status.overview";
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
let authBusy = false;
let connections = [];

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
	elements.displayMode = document.getElementById("display-mode");
	elements.displayNote = document.getElementById("display-note");
	elements.pairingLink = document.getElementById("pairing-link");
	elements.allowHttp = document.getElementById("allow-http");
	elements.pairButton = document.getElementById("pair-button");
	elements.pairingResult = document.getElementById("pairing-result");
	elements.environmentList = document.getElementById("environment-list");
	elements.environmentDetail = document.getElementById("environment-detail");
	elements.removeConnection = document.getElementById("remove-connection");
}

function bindControls() {
	elements.displayMode.addEventListener("change", saveDisplayMode);
	elements.pairButton.addEventListener("click", () => {
		const link = elements.pairingLink.value.trim();
		if (!link || authBusy) return;
		if (sendToPlugin({ command: "pair", link, allowHttp: elements.allowHttp.checked })) {
			elements.pairingLink.value = "";
			authBusy = true;
			setSettingsEnabled(socketReady);
			setTextContent(elements.pairingResult, "Pairing…");
		}
	});
	elements.removeConnection.addEventListener("click", () => {
		if (!elements.environmentList.value || authBusy) return;
		if (sendToPlugin({ command: "removeConnection", environmentId: elements.environmentList.value })) {
			authBusy = true;
			setSettingsEnabled(socketReady);
		}
	});
	elements.environmentList.addEventListener("change", renderEnvironmentDetail);
}

function setSettingsEnabled(enabled) {
	elements.displayMode.disabled = !enabled;
	elements.pairingLink.disabled = !enabled || authBusy;
	elements.allowHttp.disabled = !enabled || authBusy;
	elements.pairButton.disabled = !enabled || authBusy;
	elements.environmentList.disabled = !enabled || authBusy || connections.length === 0;
	elements.removeConnection.disabled = !enabled || authBusy || connections.length === 0;
}

function applySettings(settings) {
	elements.displayMode.value = normalizeDisplayMode(settings?.displayMode);
	updateDisplayNote();
}

function normalizeDisplayMode(value) {
	return value === "threads" || value === "questions" ? value : "combined";
}

function updateDisplayNote() {
	const descriptions = {
		combined:
			"Shows thread counts and a blinking question mark when input, approval, or plan review is pending.",
		threads: "Shows working threads / all open threads. This key does not blink for questions.",
		questions:
			"A faded question mark when clear. The whole key flashes amber while input, approval, or plan review is pending.",
	};
	elements.displayNote.textContent = descriptions[normalizeDisplayMode(elements.displayMode.value)];
}

function saveSettings() {
	return sendSocketMessage({
		event: "setSettings",
		context: actionContext,
		payload: {
			displayMode: normalizeDisplayMode(elements.displayMode.value),
			settingsVersion: SETTINGS_VERSION,
		},
	});
}

function saveDisplayMode() {
	if (saveSettings()) updateDisplayNote();
	else elements.displayNote.textContent = "Display not saved. Check the connection to OpenDeck.";
}

function sendToPlugin(payload) {
	return sendSocketMessage({
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

	if (message.event === "sendToPropertyInspector" && message.payload?.type === "pairingResult") {
		authBusy = false;
		setSettingsEnabled(socketReady);
		setTextContent(
			elements.pairingResult,
			message.payload.error ? localizeRuntimeError(message.payload.error) : "Connection settings saved.",
		);
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
	if (Array.isArray(payload.status?.connections)) renderEnvironments(payload.status.connections);
	const status = normalizeConnectionStatus(payload.status);
	const rawError = payload.error ?? payload.status?.error;
	const errorCode = typeof rawError === "string" ? rawError.trim() : "";
	const hasError =
		errorCode.length > 0 && !["connecting", "pairing-required", "authorization-required"].includes(errorCode);
	setBusy(Boolean(payload.busy));

	if (hasError) {
		setVisualState("error");
		showLocalError(localizeRuntimeError(errorCode));
	} else {
		clearError();
		setVisualState(status.state);
	}

	if (payload.busy) {
		setTextContent(elements.connectionState, busyLabel());
		setTextContent(elements.connectionDetail, "Updating the live T3 connection…");
		return;
	}
	if (hasError) {
		setTextContent(elements.connectionState, runtimeErrorLabel(errorCode));
		setTextContent(elements.connectionDetail, runtimeErrorDetail(errorCode));
		return;
	}

	switch (status.state) {
		case "connected":
			setTextContent(elements.connectionState, "Connected");
			setTextContent(elements.connectionDetail, connectedDetail(status));
			break;
		case "pairing-required":
			setTextContent(elements.connectionState, "Pair T3 Code");
			setTextContent(elements.connectionDetail, "Add a read-only pairing link below to start live updates.");
			break;
		case "authorization-required":
			setTextContent(elements.connectionState, "Pairing needed");
			setTextContent(
				elements.connectionDetail,
				"Authorization expired or was revoked. Paste a fresh read-only pairing link.",
			);
			break;
		case "connecting":
			setTextContent(elements.connectionState, "Connecting");
			setTextContent(elements.connectionDetail, "Synchronizing thread status…");
			break;
		default:
			setTextContent(elements.connectionState, "T3 Code offline");
			setTextContent(
				elements.connectionDetail,
				"Check that the paired environments are running and reachable. The plugin reconnects automatically.",
			);
	}
}

function runtimeErrorLabel(code) {
	switch (code) {
		case "offline":
			return "T3 Code offline";
		case "pairing-required":
			return "Pair T3 Code";
		case "authorization-required":
			return "Pairing needed";
		case "connecting":
			return "Connecting";
		case "invalid-response":
			return "Connection incompatible";
		default:
			return "Connection unavailable";
	}
}

function runtimeErrorDetail(code) {
	return localizeRuntimeError(code);
}

function localizeRuntimeError(code) {
	switch (code) {
		case "pairing-required":
			return "Add a read-only pairing link below to start live updates.";
		case "authorization-required":
			return "Authorization expired or was revoked. Paste a fresh read-only pairing link.";
		case "connecting":
			return "Synchronizing thread status…";
		case "invalid-link":
			return "Paste the complete pairing link, including its token.";
		case "insecure-origin":
			return "Use HTTPS, or allow HTTP only if you trust this private network.";
		case "identity-mismatch":
			return "This address now belongs to a different T3 environment. Create a new pairing link.";
		case "storage-error":
			return "The plugin could not securely read or save its credentials. Check permissions on its private configuration folder.";
		case "busy":
			return "Another connection change is still in progress.";
		case "offline":
			return "A paired environment is unreachable. Retrying automatically.";
		case "invalid-response":
			return "T3 returned an unexpected response. Check plugin and T3 Code compatibility.";
		default:
			return "The connection could not be completed. Try a fresh read-only pairing link.";
	}
}

function normalizeConnectionStatus(status) {
	if (status && typeof status === "object") {
		const state = ["connected", "connecting", "pairing-required", "authorization-required"].includes(
			status.state,
		)
			? status.state
			: "offline";
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
	return `${environmentLabel} · live stream · read only`;
}

function setBusy(busy) {
	elements.statusDial.classList.toggle("is-busy", busy);
}

function busyLabel() {
	return "Connecting";
}

function renderEnvironments(items) {
	const previous = elements.environmentList.value;
	connections = items.filter((item) => item && typeof item.environmentId === "string").slice(0, 16);
	const options = connections.map((item) => {
		const option = document.createElement("option");
		option.value = item.environmentId;
		option.textContent = `${item.label} · ${item.state}`;
		return option;
	});
	if (!options.length) {
		const option = document.createElement("option");
		option.value = "";
		option.textContent = "No paired environments";
		options.push(option);
	}
	elements.environmentList.replaceChildren(...options);
	if (connections.some((item) => item.environmentId === previous)) elements.environmentList.value = previous;
	renderEnvironmentDetail();
	setSettingsEnabled(socketReady);
}

function renderEnvironmentDetail() {
	const item = connections.find((item) => item.environmentId === elements.environmentList.value);
	setTextContent(
		elements.environmentDetail,
		item
			? `${item.origin} · Authorization expires ${new Date(item.expiresAt).toLocaleDateString()}${item.error ? ` · ${localizeRuntimeError(item.error)}` : ""}`
			: "",
	);
}

function setVisualState(state) {
	const visualState = state === "connected" ? "connected" : state === "error" ? "error" : "offline";
	elements.statusCard.dataset.state = visualState;
	elements.statusDial.dataset.state = visualState;
	elements.statusLight.dataset.state = visualState;
}

function showLocalError(message) {
	setTextContent(elements.errorMessage, message);
	setHidden(elements.errorMessage, false);
	setVisualState("error");
}

function showConnectionError(message) {
	socketReady = false;
	setSettingsEnabled(false);
	setBusy(false);
	setTextContent(elements.connectionState, "OpenDeck disconnected");
	setTextContent(
		elements.connectionDetail,
		"Close and reopen this settings panel after OpenDeck reconnects.",
	);
	showLocalError(message);
}

function showInitializationError(message) {
	setBusy(false);
	setSettingsEnabled(false);
	setTextContent(elements.connectionState, "Settings unavailable");
	setTextContent(
		elements.connectionDetail,
		"Close and reopen this settings panel. If the problem continues, restart OpenDeck.",
	);
	showLocalError(message);
}

function clearError() {
	setTextContent(elements.errorMessage, "");
	setHidden(elements.errorMessage, true);
}

function setTextContent(element, text) {
	if (element.textContent !== text) element.textContent = text;
}

function setHidden(element, hidden) {
	if (element.hidden !== hidden) element.hidden = hidden;
}

window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
