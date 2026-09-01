import { ACTION_UUID, DEFAULT_REFRESH_SECONDS, PLUGIN_UUID, SETTINGS_VERSION } from "../src/types.js";

export const PLUGIN_DIRECTORY = `${PLUGIN_UUID}.sdPlugin`;
export const MAX_OPENDECK_PROFILE_DEPTH = 64;
export const MAX_OPENDECK_PROFILE_KEYS = 1_024;
export const MAX_OPENDECK_PROFILE_VALUES = 100_000;

export interface OpenDeckProfile {
	[key: string]: unknown;
	keys: Array<Record<string, unknown> | null>;
}

export interface PlacementResult {
	alreadyPresent: boolean;
	position: number;
}

export function parseOpenDeckProfile(raw: string, path: string): OpenDeckProfile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`OpenDeck profile is not valid JSON: ${path}`);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
		throw new Error(`OpenDeck profile has no keys array: ${path}`);
	}
	if (parsed.keys.length > MAX_OPENDECK_PROFILE_KEYS) {
		throw new Error(`OpenDeck profile contains more than ${MAX_OPENDECK_PROFILE_KEYS} keys: ${path}`);
	}
	if (!parsed.keys.every((entry) => entry === null || isRecord(entry))) {
		throw new Error(`OpenDeck profile contains an invalid key entry: ${path}`);
	}
	assertOpenDeckProfileStructure(parsed, path);
	return parsed as OpenDeckProfile;
}

export function assertOpenDeckProfileStructure(root: unknown, path: string): void {
	const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: root }];
	let valueCount = 1;

	const enqueue = (value: unknown, depth: number): void => {
		if (depth > MAX_OPENDECK_PROFILE_DEPTH) {
			throw new Error(
				`OpenDeck profile exceeds the maximum JSON depth of ${MAX_OPENDECK_PROFILE_DEPTH}: ${path}`,
			);
		}
		valueCount += 1;
		if (valueCount > MAX_OPENDECK_PROFILE_VALUES) {
			throw new Error(
				`OpenDeck profile contains more than ${MAX_OPENDECK_PROFILE_VALUES} JSON values: ${path}`,
			);
		}
		pending.push({ depth, value });
	};

	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		const { depth, value } = current;
		if (value === null || typeof value === "boolean" || typeof value === "string") continue;
		if (typeof value === "number") {
			if (Number.isFinite(value)) continue;
			throw new Error(`OpenDeck profile contains a non-finite number: ${path}`);
		}
		if (Array.isArray(value)) {
			for (const child of value) enqueue(child, depth + 1);
			continue;
		}
		if (isRecord(value)) {
			for (const key in value) {
				if (Object.hasOwn(value, key)) enqueue(value[key], depth + 1);
			}
			continue;
		}
		throw new Error(`OpenDeck profile contains unsupported JSON data: ${path}`);
	}
}

export function placeOverview(profile: OpenDeckProfile): PlacementResult {
	const existingPosition = profile.keys.findIndex((key) => actionUuid(key) === ACTION_UUID);
	if (existingPosition >= 0) return { alreadyPresent: true, position: existingPosition };

	const position = profile.keys.indexOf(null);
	if (position < 0) throw new Error("The selected OpenDeck profile has no free key.");
	profile.keys[position] = createOverviewSlot(position);
	return { alreadyPresent: false, position };
}

export function createOverviewSlot(position: number): Record<string, unknown> {
	if (!Number.isSafeInteger(position) || position < 0)
		throw new Error("Key position must be zero or greater.");
	const image = `plugins/${PLUGIN_DIRECTORY}/icons/action.svg`;
	const state = actionState(image);
	return {
		action: {
			controllers: ["Keypad"],
			disable_automatic_states: true,
			encoder: null,
			icon: image,
			name: "Thread status",
			plugin: PLUGIN_DIRECTORY,
			property_inspector: `plugins/${PLUGIN_DIRECTORY}/property-inspector/index.html`,
			states: [state],
			supported_in_multi_actions: false,
			tooltip: "Shows working and waiting open T3 Code threads",
			uuid: ACTION_UUID,
			visible_in_action_list: true,
		},
		children: null,
		context: `Keypad.${position}.0`,
		current_state: 0,
		settings: { refreshSeconds: DEFAULT_REFRESH_SECONDS, settingsVersion: SETTINGS_VERSION },
		states: [state],
	};
}

function actionUuid(slot: Record<string, unknown> | null): string | undefined {
	const action = slot?.action;
	return isRecord(action) && typeof action.uuid === "string" ? action.uuid : undefined;
}

function actionState(image: string): Record<string, unknown> {
	return {
		alignment: "middle",
		background_colour: "#000000",
		colour: "#FFFFFF",
		family: "Liberation Sans",
		image,
		image_scale: 100,
		name: "",
		show: false,
		size: 16,
		stroke_colour: "#000000",
		stroke_size: 3,
		style: "Regular",
		text: "",
		underline: false,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
