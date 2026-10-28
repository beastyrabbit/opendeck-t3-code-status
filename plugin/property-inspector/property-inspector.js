const ACTION_UUID = "com.beastyrabbit.t3-code-status.overview";
// The Overview key always shows the same counts, so it only chooses a theme.
const ACTION_NOTES = {
	"com.beastyrabbit.t3-code-status.overview-tile":
		"Shows four counts on one key: running threads and what needs you on top, finished threads you have not opened and errors below.",
};
const SETTINGS_VERSION = 2;
const DISPLAY_MODES = new Set([
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
]);
const LEGACY_DISPLAY_MODES = { threads: "working", questions: "needs" };
const THEMES = new Set(["counter", "pictogram", "flood", "gauge", "quad"]);
const MAX_ACTION_INFO_CODE_UNITS = 64 * 1024;
const MAX_MESSAGE_CODE_UNITS = 64 * 1024;
const MAX_CONTEXT_CODE_UNITS = 256;
// Pair all accepts at most this many machines, the plugin's environment limit.
const MAX_SSH_HOSTS = 16;
const MESSAGE_RATE_WINDOW_MS = 1_000;
const MAX_MESSAGES_PER_WINDOW = 60;

let websocket;
let inspectorContext = "";
let actionContext = "";
let actionUuid = ACTION_UUID;
let socketReady = false;
let protocolFailed = false;
let connectionErrorShown = false;
let messageWindowStartedAt = 0;
let messagesInWindow = 0;
let authBusy = false;
let connections = [];
// Until the user types hosts, the SSH field lists the machines already paired over the network.
let sshHostsEdited = false;
let findBusy = false;
// Where the result of the running pairing command appears.
let authResult;

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
	actionUuid = Object.hasOwn(ACTION_NOTES, actionInfo.action) ? actionInfo.action : ACTION_UUID;
	showActionFields();
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
	elements.displayField = document.getElementById("display-field");
	elements.actionNote = document.getElementById("action-note");
	elements.displayMode = document.getElementById("display-mode");
	elements.displayNote = document.getElementById("display-note");
	elements.theme = document.getElementById("theme");
	elements.pairingLink = document.getElementById("pairing-link");
	elements.allowHttp = document.getElementById("allow-http");
	elements.pairButton = document.getElementById("pair-button");
	elements.sshHosts = document.getElementById("ssh-hosts");
	elements.sshPairButton = document.getElementById("ssh-pair-button");
	elements.sshFindButton = document.getElementById("ssh-find-button");
	elements.pairingResult = document.getElementById("pairing-result");
	elements.sshResult = document.getElementById("ssh-result");
	elements.environmentList = document.getElementById("environment-list");
	elements.environmentDetail = document.getElementById("environment-detail");
	elements.removeConnection = document.getElementById("remove-connection");
}

function showActionFields() {
	const actionNote = ACTION_NOTES[actionUuid];
	elements.displayField.hidden = Boolean(actionNote);
	elements.actionNote.hidden = !actionNote;
	elements.actionNote.textContent = actionNote ?? "";
}

function bindControls() {
	elements.displayMode.addEventListener("change", saveDisplayMode);
	elements.theme.addEventListener("change", saveDisplayMode);
	elements.pairButton.addEventListener("click", () => {
		const link = elements.pairingLink.value.trim();
		if (!link || authBusy) return;
		if (sendToPlugin({ command: "pair", link, allowHttp: elements.allowHttp.checked })) {
			elements.pairingLink.value = "";
			authBusy = true;
			setSettingsEnabled(socketReady);
			authResult = elements.pairingResult;
			setTextContent(elements.pairingResult, "Pairing…");
		}
	});
	elements.sshHosts.addEventListener("input", () => {
		sshHostsEdited = true;
	});
	elements.sshFindButton.addEventListener("click", () => {
		if (findBusy || authBusy) return;
		if (sendToPlugin({ command: "discoverHosts" })) {
			findBusy = true;
			setSettingsEnabled(socketReady);
			setTextContent(elements.sshResult, "Looking for T3 Code on Tailscale…");
		}
	});
	elements.sshPairButton.addEventListener("click", () => {
		const hosts = elements.sshHosts.value.trim();
		if (!hosts || authBusy) return;
		if (sendToPlugin({ command: "pairSsh", hosts, allowHttp: elements.allowHttp.checked })) {
			authBusy = true;
			setSettingsEnabled(socketReady);
			authResult = elements.sshResult;
			setTextContent(elements.sshResult, "Pairing over SSH…");
		}
	});
	elements.removeConnection.addEventListener("click", () => {
		if (!elements.environmentList.value || authBusy) return;
		if (sendToPlugin({ command: "removeConnection", environmentId: elements.environmentList.value })) {
			authResult = elements.pairingResult;
			authBusy = true;
			setSettingsEnabled(socketReady);
		}
	});
	elements.environmentList.addEventListener("change", renderEnvironmentDetail);
}

function setSettingsEnabled(enabled) {
	elements.displayMode.disabled = !enabled;
	elements.theme.disabled = !enabled;
	elements.pairingLink.disabled = !enabled || authBusy;
	elements.allowHttp.disabled = !enabled || authBusy;
	elements.pairButton.disabled = !enabled || authBusy;
	elements.sshHosts.disabled = !enabled || authBusy;
	elements.sshPairButton.disabled = !enabled || authBusy;
	elements.sshFindButton.disabled = !enabled || authBusy || findBusy;
	elements.environmentList.disabled = !enabled || authBusy || connections.length === 0;
	elements.removeConnection.disabled = !enabled || authBusy || connections.length === 0;
}

function applySettings(settings) {
	elements.displayMode.value = normalizeDisplayMode(settings?.displayMode);
	elements.theme.value = normalizeTheme(settings?.theme);
	updateDisplayNote();
}

function normalizeDisplayMode(value) {
	if (Object.hasOwn(LEGACY_DISPLAY_MODES, value)) return LEGACY_DISPLAY_MODES[value];
	return DISPLAY_MODES.has(value) ? value : "combined";
}

function normalizeTheme(value) {
	return THEMES.has(value) ? value : "counter";
}

function updateDisplayNote() {
	const descriptions = {
		combined: "Shows whatever is most urgent right now.",
		working: "Shows working threads and the number of open threads.",
		needs: "Blinks while any thread waits for your approval, answer, or plan review.",
		approval: "Blinks while a thread waits for you to approve a command or change.",
		question: "Blinks while a thread asks you a question.",
		plan: "Blinks while a proposed plan waits for your review.",
		failed: "Shows threads whose latest run failed.",
		limit: "Shows threads paused until a provider usage limit resets.",
		background: "Shows threads with background tasks, such as a dev server or monitor.",
		waiting: "Shows open threads that are idle and need nothing from you.",
	};
	elements.displayNote.textContent = descriptions[normalizeDisplayMode(elements.displayMode.value)];
}

function saveSettings() {
	return sendSocketMessage({
		event: "setSettings",
		context: actionContext,
		payload: {
			displayMode: normalizeDisplayMode(elements.displayMode.value),
			theme: normalizeTheme(elements.theme.value),
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
		action: actionUuid,
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

function describePairingResult(payload) {
	if (payload.error) return localizeRuntimeError(payload.error);
	if (Array.isArray(payload.hosts)) return describeSshResults(payload.hosts.slice(0, 16));
	return "Connection settings saved.";
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
		setTextContent(authResult ?? elements.pairingResult, describePairingResult(message.payload));
		return;
	}
	if (message.event === "sendToPropertyInspector" && message.payload?.type === "discoveryResult") {
		findBusy = false;
		setSettingsEnabled(socketReady);
		showDiscoveredHosts(message.payload.hosts);
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
		case "unsupported-version":
			return "Unsupported T3 version";
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
		case "unsupported-version":
			return "This T3 Code version uses a different orchestration protocol. Update T3 Code or this plugin.";
		case "invalid-host":
			return "Enter up to 16 host names separated by commas, like anvil, kiln, devbox:3774.";
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
	// Machines that are offline or still connecting are left out of the counts.
	const missing = connections
		.filter((item) => item.state !== "connected")
		.map((item) => String(item.label).slice(0, 80));
	if (missing.length > 0) {
		const live = status.environments - missing.length;
		return `${live} of ${status.environments} Environments live · not counted: ${missing.join(", ")}`;
	}
	const environmentLabel =
		status.environments === 1 ? "1 Environment" : `${status.environments} Environments`;
	return `${environmentLabel} · live stream · read only`;
}

/** One line for the paired machines, then one short line per machine that failed. */
function describeSshResults(results) {
	const name = (result) => (typeof result?.host === "string" ? result.host.slice(0, 260) : "?");
	const paired = results.filter((result) => !result?.error).map(name);
	const failed = results
		.filter((result) => result?.error)
		.map((result) => `${name(result)}: ${sshErrorMessage(String(result.error))}`);
	return [paired.length ? `Paired ${paired.join(", ")}.` : "Nothing was paired.", ...failed].join("\n");
}

function sshErrorMessage(code) {
	switch (code) {
		case "ssh-failed":
			return "SSH login failed";
		case "t3-missing":
		case "t3-failed":
			return "no working t3 command over SSH";
		case "offline":
			return "T3 Code not reachable; turn on Network access there";
		case "insecure-origin":
			return "allow unencrypted HTTP to pair it";
		default:
			return localizeRuntimeError(code);
	}
}

function showDiscoveredHosts(value) {
	const found = Array.isArray(value)
		? value.filter((host) => typeof host === "string" && host.length <= 260).slice(0, 64)
		: [];
	if (!found.length) {
		setTextContent(
			elements.sshResult,
			"No T3 Code found on Tailscale. Each machine needs Network access turned on in T3 Code.",
		);
		return;
	}
	const current = elements.sshHosts.value.split(/[\s,]+/).filter(Boolean);
	const merged = [...new Set([...current, ...found])];
	elements.sshHosts.value = merged.slice(0, MAX_SSH_HOSTS).join(", ");
	sshHostsEdited = true;
	const machines = found.length === 1 ? "machine" : "machines";
	const leftOut = merged.length - MAX_SSH_HOSTS;
	setTextContent(
		elements.sshResult,
		leftOut > 0
			? `Found ${found.length} ${machines}. Pair all takes ${MAX_SSH_HOSTS} at a time; ${leftOut} did not fit in the list.`
			: `Found ${found.length} ${machines}. Press Pair all.`,
	);
}

/** Remote machines already paired over plain HTTP, as host or host:port. */
function pairedSshHosts(items) {
	const hosts = new Set();
	for (const item of items) {
		try {
			const url = new URL(item.origin);
			if (url.protocol !== "http:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) continue;
			hosts.add(url.port && url.port !== "3773" ? `${url.hostname}:${url.port}` : url.hostname);
		} catch {
			// Skip origins that are not URLs.
		}
	}
	return [...hosts].join(", ");
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
	if (!sshHostsEdited) elements.sshHosts.value = pairedSshHosts(connections);
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
