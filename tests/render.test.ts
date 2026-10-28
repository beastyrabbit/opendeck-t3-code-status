import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getAccessibleTitle, isAlerting, renderKey } from "../src/render.js";
import { emptySummary } from "../src/status.js";
import { type DashboardModel, DISPLAY_MODES, THEMES, type ThreadSummary } from "../src/types.js";

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
	return { ...emptySummary(), ...overrides };
}

function ready(overrides: Partial<ThreadSummary> = {}): DashboardModel {
	return { kind: "ready", refreshedAt: 0, summary: summary(overrides) };
}

function svg(image: string): string {
	assert.match(image, /^data:image\/svg\+xml;base64,/);
	return Buffer.from(image.slice(image.indexOf(",") + 1), "base64").toString("utf8");
}

const CALM = ready({
	total: 7,
	running: 3,
	working: 3,
	waiting: 3,
	monitoring: 1,
	attention: 4,
	background: 1,
});
const BUSY = ready({
	total: 13,
	running: 4,
	working: 4,
	approval: 1,
	input: 2,
	plan: 1,
	failed: 1,
	limited: 1,
	waiting: 3,
	attention: 9,
	background: 2,
});
const CONNECTIONS: DashboardModel[] = [
	{ kind: "loading" },
	{ kind: "offline" },
	{ kind: "pairing" },
	{ kind: "reauth" },
	{ kind: "unsupported" },
	{ kind: "error" },
];

describe("renderKey", () => {
	test("every theme draws every key type and connection state with plain SVG primitives", () => {
		for (const theme of THEMES) {
			for (const mode of [...DISPLAY_MODES, "overview"] as const) {
				for (const model of [CALM, BUSY, ready(), ...CONNECTIONS]) {
					for (const phase of [false, true]) {
						const document = svg(renderKey(model, mode, theme, phase));
						assert.match(document, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="144" height="144"/);
						const tags = new Set([...document.matchAll(/<([a-z]+)/g)].map((match) => match[1]));
						for (const tag of tags)
							assert.ok(
								["svg", "rect", "circle", "path", "line", "polygon", "text"].includes(tag ?? ""),
								tag,
							);
						assert.doesNotMatch(document, /NaN|undefined/, `${theme} ${mode} ${model.kind}`);
					}
				}
			}
		}
	});

	test("connection states name what the user should do", () => {
		for (const theme of THEMES) {
			assert.match(svg(renderKey({ kind: "offline" }, "combined", theme)), />OFF<\/text>/);
			assert.match(svg(renderKey({ kind: "pairing" }, "working", theme)), />PAIR<\/text>/);
			assert.match(svg(renderKey({ kind: "reauth" }, "needs", theme)), />RE-PAIR<\/text>/);
			assert.match(svg(renderKey({ kind: "unsupported" }, "failed", theme)), />VERSION<\/text>/);
			assert.match(svg(renderKey({ kind: "error" }, "combined", theme)), />ERROR<\/text>/);
		}
	});

	test("the combined counter shows the most urgent count with the open total", () => {
		const calm = svg(renderKey(CALM, "combined", "counter"));
		assert.match(calm, />3<\/text>/);
		assert.match(calm, />7<\/text>/);
		assert.match(calm, /fill="#4CE08A"/);
		const busy = svg(renderKey(BUSY, "combined", "counter"));
		assert.match(busy, />4<\/text>/);
		assert.match(busy, />13<\/text>/);
		assert.match(busy, /fill="#FFC83D"/);
		const failed = svg(renderKey(ready({ total: 2, running: 1, failed: 1 }), "combined", "counter"));
		assert.match(failed, /fill="#FF5A6E"/);
		const limited = svg(renderKey(ready({ total: 2, limited: 2 }), "combined", "counter"));
		assert.match(limited, /fill="#B48CFF"/);
	});

	test("the blink frame floods a key that needs the user, and no other", () => {
		const steady = svg(renderKey(BUSY, "needs", "counter", false));
		const flash = svg(renderKey(BUSY, "needs", "counter", true));
		assert.match(steady, /^<svg[^>]*><rect width="144" height="144" rx="17" fill="#0E141A"/);
		assert.match(flash, /^<svg[^>]*><rect width="144" height="144" rx="17" fill="#FFC83D"/);
		assert.equal(renderKey(BUSY, "working", "counter", true), renderKey(BUSY, "working", "counter", false));
		assert.equal(renderKey(CALM, "needs", "counter", true), renderKey(CALM, "needs", "counter", false));
	});

	test("single-status keys show their own count", () => {
		assert.match(svg(renderKey(BUSY, "question", "flood")), />2<\/text>/);
		assert.match(svg(renderKey(BUSY, "background", "pictogram")), />2<\/text>/);
		assert.match(svg(renderKey(BUSY, "waiting", "quad")), />3<\/text>/);
		assert.match(svg(renderKey(BUSY, "working", "flood")), />\/13<\/text>/);
	});

	test("the Overview key shows active and waiting runs, needs you, done not seen, and errors", () => {
		const state = ready({
			total: 15,
			running: 14,
			working: 14,
			blocked: 3,
			approval: 1,
			input: 1,
			waiting: 1,
			unseen: 1,
			failed: 1,
			limited: 1,
		});
		for (const theme of THEMES) {
			const key = svg(renderKey(state, "overview", theme));
			// 14 running, 3 of them waiting: the big number shows the 11 active ones.
			// Gauge draws the waiting part as a grey stretch of the ring instead of a number.
			for (const count of theme === "gauge" ? [11, 2, 1] : [11, 3, 2, 1])
				assert.match(key, new RegExp(`>${count}</text>`), `${theme} ${count}`);
		}
		const quad = svg(renderKey(state, "overview", "quad"));
		for (const [count, color] of [
			[11, "#4CE08A"],
			[3, "#97A5B0"],
			[2, "#FFC83D"],
			[1, "#48C8F5"],
			[2, "#FF5A6E"],
		] as const)
			assert.match(quad, new RegExp(`fill="${color}"[^>]*>${count}</text>`), `${count} ${color}`);
		assert.doesNotMatch(
			svg(renderKey(ready({ total: 2, running: 2, working: 2 }), "overview", "quad")),
			/#97A5B0/,
		);
		// When every running thread only waits, the cell stays lit with a dim zero.
		for (const theme of THEMES) {
			const allWaiting = svg(
				renderKey(ready({ total: 2, running: 2, working: 2, blocked: 2 }), "overview", theme),
			);
			assert.match(allWaiting, /#4CE08A/, `${theme} lit`);
			const zero = allWaiting.match(/fill="(#[0-9A-F]{6})"[^>]*>0<\/text>/)?.[1];
			assert.ok(zero, `${theme} zero`);
			// Full-contrast count colours: green, white, and the ink on a lit Flood cell.
			assert.ok(!["#4CE08A", "#F2F6F8", "#0B1116"].includes(zero), `${theme} zero is dim, not ${zero}`);
		}
	});

	test("the Thread status key shows unseen finished threads before running ones", () => {
		const key = svg(
			renderKey(ready({ total: 5, running: 4, working: 4, waiting: 1, unseen: 1 }), "combined", "counter"),
		);
		assert.match(key, /fill="#48C8F5"[^>]*>1<\/text>/);
		assert.equal(
			getAccessibleTitle(ready({ total: 5, running: 4, working: 4, waiting: 1, unseen: 1 })),
			"4 of 5 working, 1 done, not seen",
		);
	});

	test("the Overview key never blinks", () => {
		for (const theme of THEMES)
			assert.equal(
				renderKey(BUSY, "overview", theme, true),
				renderKey(BUSY, "overview", theme, false),
				theme,
			);
	});

	test("every theme's Thread status key switches to the most urgent state", () => {
		const quad = svg(renderKey(BUSY, "combined", "quad"));
		assert.match(quad, /fill="#FFC83D"[^>]*>4<\/text>/);
		assert.doesNotMatch(quad, />13<\/text>/);
		assert.match(svg(renderKey(ready({ total: 5, waiting: 5 }), "combined", "quad")), />5<\/text>/);
	});

	test("three-digit counts shrink to the width two digits take", () => {
		const key = svg(renderKey(ready({ total: 120, waiting: 100 }), "waiting", "counter"));
		const size = Number(/font-size="([\d.]+)"[^>]*>100<\/text>/.exec(key)?.[1]);
		assert.ok(size > 0 && size <= (86 * 2) / 3 + 0.1, String(size));
	});

	test("a long ratio pill stays on the key", () => {
		const key = svg(renderKey(ready({ total: 100, running: 100, working: 100 }), "combined", "pictogram"));
		const rect = /<rect x="([\d.-]+)" y="\d+" width="(\d+)"[^>]*\/><text[^>]*>100\/100<\/text>/.exec(key);
		assert.ok(rect, "pill drawn");
		assert.ok(Number(rect[1]) >= 4 && Number(rect[1]) + Number(rect[2]) <= 140, `${rect[1]} ${rect[2]}`);
	});

	test("themes look different", () => {
		const images = new Set(THEMES.map((theme) => renderKey(BUSY, "combined", theme)));
		assert.equal(images.size, THEMES.length);
	});
});

describe("isAlerting", () => {
	test("only request keys blink, and only while requests are pending", () => {
		assert.equal(isAlerting(BUSY, "combined"), true);
		assert.equal(isAlerting(BUSY, "needs"), true);
		assert.equal(isAlerting(BUSY, "approval"), true);
		assert.equal(isAlerting(BUSY, "plan"), true);
		assert.equal(isAlerting(BUSY, "working"), false);
		assert.equal(isAlerting(BUSY, "failed"), false);
		assert.equal(isAlerting(BUSY, "overview"), false);
		assert.equal(isAlerting(CALM, "overview"), false);
		assert.equal(isAlerting(CALM, "combined"), false);
		assert.equal(isAlerting(ready({ total: 1, input: 1 }), "approval"), false);
		assert.equal(isAlerting({ kind: "offline" }, "needs"), false);
	});
});

describe("getAccessibleTitle", () => {
	test("describes the combined state", () => {
		assert.equal(getAccessibleTitle(ready()), "No open T3 Code threads");
		assert.equal(getAccessibleTitle(ready({ total: 3, running: 3 })), "3 of 3 threads working");
		assert.equal(getAccessibleTitle(CALM), "3 of 7 working, 4 waiting");
		assert.equal(
			getAccessibleTitle(BUSY),
			"4 of 13 working, 1 error, 4 need your attention, 1 paused by a usage limit",
		);
	});

	test("describes each single-status key", () => {
		assert.equal(getAccessibleTitle(BUSY, "working"), "4 of 13 threads working");
		assert.equal(getAccessibleTitle(BUSY, "needs"), "4 threads need your input, approval, or plan review");
		assert.equal(getAccessibleTitle(CALM, "needs"), "No T3 Code questions pending");
		assert.equal(getAccessibleTitle(BUSY, "approval"), "1 thread needs your approval");
		assert.equal(getAccessibleTitle(BUSY, "question"), "2 threads ask you a question");
		assert.equal(getAccessibleTitle(BUSY, "plan"), "1 plan is ready for review");
		assert.equal(getAccessibleTitle(BUSY, "failed"), "1 thread failed");
		assert.equal(getAccessibleTitle(BUSY, "limit"), "1 thread is paused by a usage limit");
		assert.equal(getAccessibleTitle(BUSY, "background"), "2 threads have background tasks");
		assert.equal(getAccessibleTitle(BUSY, "waiting"), "3 threads are waiting");
	});

	test("describes connection states", () => {
		assert.equal(getAccessibleTitle({ kind: "loading" }), "Loading T3 Code status");
		assert.equal(getAccessibleTitle({ kind: "offline" }), "T3 Code offline");
		assert.equal(getAccessibleTitle({ kind: "pairing" }), "Pair T3 Code in the OpenDeck key settings");
		assert.equal(
			getAccessibleTitle({ kind: "reauth" }),
			"T3 Code authorization expired. Pair again in the OpenDeck key settings",
		);
		assert.equal(getAccessibleTitle({ kind: "unsupported" }), "Unsupported T3 Code version");
		assert.equal(getAccessibleTitle({ kind: "error" }), "T3 Code status error");
	});
});
