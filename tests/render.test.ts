import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getAccessibleTitle, getDisplay, renderDashboard } from "../src/render.js";
import type { DashboardModel, ThreadSummary } from "../src/types.js";

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		total: 0,
		running: 0,
		attention: 0,
		approval: 0,
		input: 0,
		failed: 0,
		starting: 0,
		working: 0,
		monitoring: 0,
		plan: 0,
		waiting: 0,
		...overrides,
	};
}

describe("getDisplay", () => {
	test("shows the running fraction and waiting count", () => {
		assert.deepEqual(
			getDisplay({
				kind: "ready",
				refreshedAt: 0,
				summary: summary({ total: 6, running: 4, attention: 2, waiting: 2, working: 4 }),
			}),
			{ accent: "#CBCB78", count: "4/6", footer: "2 WAITING", label: "T3 CODE" },
		);
	});

	test("puts failures ahead of all other attention states", () => {
		assert.deepEqual(
			getDisplay({
				kind: "ready",
				refreshedAt: 0,
				summary: summary({
					total: 4,
					running: 1,
					attention: 3,
					failed: 1,
					approval: 1,
					waiting: 1,
					working: 1,
				}),
			}),
			{
				accent: "#FF9269",
				count: "1/4",
				footer: "1 ERROR",
				footerAccent: "#FF667D",
				label: "T3 CODE",
			},
		);
	});

	test("uses singular and plural copy for direct attention", () => {
		assert.equal(
			getDisplay({
				kind: "ready",
				refreshedAt: 0,
				summary: summary({ total: 1, attention: 1, input: 1 }),
			}).footer,
			"1 NEEDS YOU",
		);
		assert.equal(
			getDisplay({
				kind: "ready",
				refreshedAt: 0,
				summary: summary({ total: 2, attention: 2, approval: 1, plan: 1 }),
			}).footer,
			"2 NEED YOU",
		);
	});

	test("handles an empty dashboard and a fully running dashboard", () => {
		assert.deepEqual(getDisplay({ kind: "ready", refreshedAt: 0, summary: summary() }), {
			accent: "#6F858E",
			count: "0/0",
			footer: "NO THREADS",
			label: "T3 CODE",
		});
		assert.deepEqual(
			getDisplay({
				kind: "ready",
				refreshedAt: 0,
				summary: summary({ total: 6, running: 6, working: 6 }),
			}),
			{ accent: "#63E6BE", count: "6/6", footer: "ALL WORKING", label: "T3 CODE" },
		);
	});

	test("interpolates the running ratio from red through yellow to green", () => {
		const cases = [
			{ expected: "#FF667D", running: 0, total: 7 },
			{ expected: "#FFBE55", running: 1, total: 2 },
			{ expected: "#90DBA0", running: 6, total: 7 },
			{ expected: "#63E6BE", running: 7, total: 7 },
		];

		for (const { expected, running, total } of cases) {
			const attention = total - running;
			assert.equal(
				getDisplay({
					kind: "ready",
					refreshedAt: 0,
					summary: summary({ attention, running, total, waiting: attention, working: running }),
				}).accent,
				expected,
			);
		}
	});

	test("maps connection states to short key labels", () => {
		const cases: Array<[DashboardModel, ReturnType<typeof getDisplay>]> = [
			[{ kind: "loading" }, { accent: "#51D7E8", count: "···", footer: "LOADING", label: "T3 CODE" }],
			[{ kind: "offline" }, { accent: "#6F858E", count: "OFF", footer: "T3 OFFLINE", label: "T3 CODE" }],
			[{ kind: "error" }, { accent: "#FF667D", count: "ERR", footer: "STATUS ERROR", label: "T3 CODE" }],
		];

		for (const [model, expected] of cases) {
			assert.deepEqual(getDisplay(model), expected);
		}
	});
});

describe("getAccessibleTitle", () => {
	test("describes connection states and an empty dashboard", () => {
		assert.equal(getAccessibleTitle({ kind: "loading" }), "Loading T3 Code status");
		assert.equal(getAccessibleTitle({ kind: "offline" }), "T3 Code offline");
		assert.equal(getAccessibleTitle({ kind: "error" }), "T3 Code status error");
		assert.equal(
			getAccessibleTitle({ kind: "ready", refreshedAt: 0, summary: summary() }),
			"No open T3 Code threads",
		);
	});

	test("describes working, waiting, attention, and error counts", () => {
		const cases: Array<[Partial<ThreadSummary>, string]> = [
			[{ total: 1, running: 1, working: 1 }, "1 of 1 thread working"],
			[{ total: 6, running: 6, working: 6 }, "6 of 6 threads working"],
			[{ total: 6, running: 4, attention: 2, waiting: 2, working: 4 }, "4 of 6 working, 2 waiting"],
			[
				{ total: 2, running: 1, attention: 1, approval: 1, working: 1 },
				"1 of 2 working, 1 needs your attention",
			],
			[{ total: 2, attention: 2, failed: 2 }, "0 of 2 working, 2 errors"],
		];
		for (const [overrides, expected] of cases) {
			assert.equal(
				getAccessibleTitle({ kind: "ready", refreshedAt: 0, summary: summary(overrides) }),
				expected,
			);
		}
	});
});

function decodeSvg(dataUrl: string): string {
	const prefix = "data:image/svg+xml;base64,";
	assert.ok(dataUrl.startsWith(prefix));
	return Buffer.from(dataUrl.slice(prefix.length), "base64").toString("utf8");
}

test("renderDashboard returns a self-contained 144-pixel SVG", () => {
	const model: DashboardModel = {
		kind: "ready",
		refreshedAt: 0,
		summary: summary({ total: 6, running: 4, attention: 2, waiting: 2, working: 4 }),
	};
	const svg = decodeSvg(renderDashboard(model, 0.25));

	assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="144" height="144"/);
	assert.match(svg, />4\/6<\/text>/);
	assert.match(svg, />2 WAITING<\/text>/);
	assert.match(svg, /stroke-dasharray="383\.27"/);
	assert.match(svg, /stroke-dashoffset="287\.46"/);
	assert.match(svg, /<circle cx="133\.00" cy="72\.00" r="3\.5" fill="#CBCB78"\/>/);
	assert.equal(svg.endsWith("</svg>"), true);
});

test("renderDashboard clamps ring progress at both ends", () => {
	const low = decodeSvg(renderDashboard({ kind: "loading" }, -10));
	const high = decodeSvg(renderDashboard({ kind: "loading" }, 10));

	assert.match(low, /stroke-dashoffset="383\.27"/);
	assert.match(low, /<circle cx="72\.00" cy="11\.00" r="3\.5"/);
	assert.match(high, /stroke-dashoffset="0\.00"/);
	assert.match(high, /<circle cx="72\.00" cy="11\.00" r="3\.5"/);
});

test("renderDashboard scales large counts and long footer copy to stay inside the key", () => {
	const model: DashboardModel = {
		kind: "ready",
		refreshedAt: 0,
		summary: summary({ total: 160_000, attention: 160_000, failed: 160_000 }),
	};
	const svg = decodeSvg(renderDashboard(model, 0));
	assert.match(svg, /font-size="14" font-weight="800" letter-spacing="-2">0\/160000/);
	assert.match(svg, /font-size="10" font-weight="800" letter-spacing="0\.3">160000 ERRORS/);
});

test("renderDashboard keeps failures red independently of a healthy running ratio", () => {
	const model: DashboardModel = {
		kind: "ready",
		refreshedAt: 0,
		summary: summary({ total: 7, running: 6, attention: 1, failed: 1, working: 6 }),
	};
	const svg = decodeSvg(renderDashboard(model, 0.5));
	assert.match(svg, /<circle cx="72" cy="72" r="61" fill="none" stroke="#90DBA0"/);
	assert.match(svg, /fill="#FF667D"[^>]*>1 ERROR<\/text>/);
});
