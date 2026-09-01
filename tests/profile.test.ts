import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	createOverviewSlot,
	MAX_OPENDECK_PROFILE_DEPTH,
	MAX_OPENDECK_PROFILE_KEYS,
	MAX_OPENDECK_PROFILE_VALUES,
	PLUGIN_DIRECTORY,
	parseOpenDeckProfile,
	placeOverview,
} from "../scripts/profile.js";
import { ACTION_UUID, DEFAULT_REFRESH_SECONDS, SETTINGS_VERSION } from "../src/types.js";

test("createOverviewSlot matches OpenDeck's serialized action shape", () => {
	const slot = createOverviewSlot(6);
	const action = slot.action as Record<string, unknown>;

	assert.equal(slot.context, "Keypad.6.0");
	assert.deepEqual(slot.settings, {
		refreshSeconds: DEFAULT_REFRESH_SECONDS,
		settingsVersion: SETTINGS_VERSION,
	});
	assert.equal(action.uuid, ACTION_UUID);
	assert.equal(action.plugin, PLUGIN_DIRECTORY);
	assert.equal(action.property_inspector, `plugins/${PLUGIN_DIRECTORY}/property-inspector/index.html`);
	assert.equal(action.icon, `plugins/${PLUGIN_DIRECTORY}/icons/action.svg`);
	assert.equal(action.disable_automatic_states, true);
	assert.equal(action.visible_in_action_list, true);
	assert.deepEqual(slot.states, [
		{
			alignment: "middle",
			background_colour: "#000000",
			colour: "#FFFFFF",
			family: "Liberation Sans",
			image: `plugins/${PLUGIN_DIRECTORY}/icons/action.svg`,
			image_scale: 100,
			name: "",
			show: true,
			size: 0,
			stroke_colour: "#000000",
			stroke_size: 3,
			style: "Regular",
			text: "Loading T3 Code status",
			underline: false,
		},
	]);
	assert.deepEqual(action.states, slot.states);
});

describe("placeOverview", () => {
	test("uses the first free key", () => {
		const profile = parseOpenDeckProfile('{"infobars":[],"keys":[{},null,null],"sliders":[]}', "test.json");
		const result = placeOverview(profile);

		assert.deepEqual(result, { alreadyPresent: false, position: 1, profileChanged: true });
		const action = profile.keys[1]?.action;
		assert.ok(action && typeof action === "object");
		assert.equal((action as Record<string, unknown>).uuid, ACTION_UUID);
		assert.equal(profile.keys[2], null);
	});

	test("keeps an accessible existing action and its settings untouched", () => {
		const existing = createOverviewSlot(1);
		existing.settings = { custom: "kept", refreshSeconds: 90 };
		existing.unknown = { nested: true };
		const profile = { keys: [null, existing, null] };

		assert.deepEqual(placeOverview(profile), {
			alreadyPresent: true,
			position: 1,
			profileChanged: false,
		});
		assert.equal(profile.keys[0], null);
		assert.equal(profile.keys[1], existing);
		assert.deepEqual(existing.settings, { custom: "kept", refreshSeconds: 90 });
		assert.deepEqual(existing.unknown, { nested: true });
	});

	test("migrates both state copies from an earlier release without replacing the slot", () => {
		const existing = structuredClone(createOverviewSlot(1));
		const action = existing.action as Record<string, unknown>;
		const instanceState = (existing.states as Array<Record<string, unknown>>)[0];
		const actionState = (action.states as Array<Record<string, unknown>>)[0];
		assert.ok(instanceState && actionState);
		Object.assign(instanceState, { instanceOnly: "kept", show: false, size: 16, text: "" });
		Object.assign(actionState, { actionOnly: "kept", show: false, size: 16, text: "" });
		existing.settings = { custom: "kept", refreshSeconds: 90 };
		existing.unknown = { nested: true };
		action.unknown = ["kept"];
		const profile = { keys: [null, existing, null] };

		assert.deepEqual(placeOverview(profile), {
			alreadyPresent: true,
			position: 1,
			profileChanged: true,
		});
		assert.equal(profile.keys[1], existing);
		assert.deepEqual(existing.settings, { custom: "kept", refreshSeconds: 90 });
		assert.deepEqual(existing.unknown, { nested: true });
		assert.deepEqual(action.unknown, ["kept"]);
		assert.deepEqual(
			{ show: instanceState.show, size: instanceState.size, text: instanceState.text },
			{ show: true, size: 0, text: "Loading T3 Code status" },
		);
		assert.equal(instanceState.instanceOnly, "kept");
		assert.deepEqual(
			{ show: actionState.show, size: actionState.size, text: actionState.text },
			{ show: true, size: 0, text: "Loading T3 Code status" },
		);
		assert.equal(actionState.actionOnly, "kept");
	});

	test("migrates every existing action instance in the profile", () => {
		const first = structuredClone(createOverviewSlot(0));
		const second = structuredClone(createOverviewSlot(2));
		for (const slot of [first, second]) {
			const action = slot.action as Record<string, unknown>;
			for (const owner of [slot, action]) {
				const state = (owner.states as Array<Record<string, unknown>>)[0];
				assert.ok(state);
				Object.assign(state, { show: false, size: 16, text: "" });
			}
		}
		first.settings = { refreshSeconds: 90 };
		second.settings = { refreshSeconds: 120 };
		const profile = { keys: [first, null, second] };

		assert.deepEqual(placeOverview(profile), {
			alreadyPresent: true,
			position: 0,
			profileChanged: true,
		});
		for (const slot of [first, second]) {
			const action = slot.action as Record<string, unknown>;
			for (const owner of [slot, action]) {
				const state = (owner.states as Array<Record<string, unknown>>)[0];
				assert.deepEqual(
					{ show: state?.show, size: state?.size, text: state?.text },
					{ show: true, size: 0, text: "Loading T3 Code status" },
				);
			}
		}
		assert.deepEqual(first.settings, { refreshSeconds: 90 });
		assert.deepEqual(second.settings, { refreshSeconds: 120 });
	});

	test("rejects a full profile", () => {
		assert.throws(() => placeOverview({ keys: [{}, {}] }), /no free key/);
	});
});

describe("parseOpenDeckProfile", () => {
	test("rejects malformed profiles", () => {
		assert.throws(() => parseOpenDeckProfile("not json", "broken.json"), /not valid JSON/);
		assert.throws(() => parseOpenDeckProfile('{"keys":"wrong"}', "broken.json"), /no keys array/);
		assert.throws(() => parseOpenDeckProfile('{"keys":[1]}', "broken.json"), /invalid key entry/);
		assert.throws(
			() => parseOpenDeckProfile('{"keys":[],"metadata":1e400}', "broken.json"),
			/non-finite number/,
		);
	});

	test("accepts the key limit and rejects one key over it", () => {
		assert.equal(
			parseOpenDeckProfile(
				JSON.stringify({ keys: Array.from({ length: MAX_OPENDECK_PROFILE_KEYS }, () => null) }),
				"limit.json",
			).keys.length,
			MAX_OPENDECK_PROFILE_KEYS,
		);
		assert.throws(
			() =>
				parseOpenDeckProfile(
					JSON.stringify({ keys: Array.from({ length: MAX_OPENDECK_PROFILE_KEYS + 1 }, () => null) }),
					"too-many-keys.json",
				),
			/more than .* keys/,
		);
	});

	test("validates nesting iteratively and rejects one level over the limit", () => {
		const atLimit = `${'{"nested":'.repeat(MAX_OPENDECK_PROFILE_DEPTH - 1)}null${"}".repeat(
			MAX_OPENDECK_PROFILE_DEPTH - 1,
		)}`;
		assert.doesNotThrow(() => parseOpenDeckProfile(`{"keys":[],"metadata":${atLimit}}`, "depth-limit.json"));

		const overLimit = `{"nested":${atLimit}}`;
		assert.throws(
			() => parseOpenDeckProfile(`{"keys":[],"metadata":${overLimit}}`, "too-deep.json"),
			/maximum JSON depth/,
		);
	});

	test("caps the total number of JSON values", () => {
		const valuesAtLimit = MAX_OPENDECK_PROFILE_VALUES - 3;
		assert.doesNotThrow(() =>
			parseOpenDeckProfile(
				JSON.stringify({ keys: [], metadata: Array.from({ length: valuesAtLimit }, () => null) }),
				"value-limit.json",
			),
		);
		assert.throws(
			() =>
				parseOpenDeckProfile(
					JSON.stringify({ keys: [], metadata: Array.from({ length: valuesAtLimit + 1 }, () => null) }),
					"too-many-values.json",
				),
			/more than .* JSON values/,
		);
	});
});
