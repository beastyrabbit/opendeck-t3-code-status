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
});

describe("placeOverview", () => {
	test("uses the first free key", () => {
		const profile = parseOpenDeckProfile('{"infobars":[],"keys":[{},null,null],"sliders":[]}', "test.json");
		const result = placeOverview(profile);

		assert.deepEqual(result, { alreadyPresent: false, position: 1 });
		const action = profile.keys[1]?.action;
		assert.ok(action && typeof action === "object");
		assert.equal((action as Record<string, unknown>).uuid, ACTION_UUID);
		assert.equal(profile.keys[2], null);
	});

	test("keeps an existing action and its settings untouched", () => {
		const existing = {
			action: { uuid: ACTION_UUID },
			settings: { refreshSeconds: 90 },
		};
		const profile = { keys: [null, existing, null] };

		assert.deepEqual(placeOverview(profile), { alreadyPresent: true, position: 1 });
		assert.equal(profile.keys[0], null);
		assert.equal(profile.keys[1], existing);
		assert.deepEqual(existing.settings, { refreshSeconds: 90 });
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
