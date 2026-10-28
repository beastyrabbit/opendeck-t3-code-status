import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderKey } from "../src/render.js";
import { emptySummary } from "../src/status.js";
import {
	type DashboardModel,
	type RenderMode,
	THEMES,
	type Theme,
	type ThreadSummary,
} from "../src/types.js";

// The key pictures in docs/user come from the real renderer, so they cannot drift from the plugin.
// Regenerate them with `pnpm docs:images`; a test fails while they are out of date.

export const DOCS_IMAGE_DIRECTORY = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"docs",
	"user",
	"images",
);

const KEY = 144;
const GAP = 24;
const LABEL = 28;

function ready(overrides: Partial<ThreadSummary>): DashboardModel {
	return { kind: "ready", refreshedAt: 0, summary: { ...emptySummary(), ...overrides } };
}

// 10 open threads: 7 working, 2 of them waiting on a subagent, 1 question, 1 failure, 1 done but unseen.
const BUSY = ready({
	total: 10,
	running: 7,
	working: 7,
	blocked: 2,
	input: 1,
	failed: 1,
	waiting: 1,
	unseen: 1,
	background: 1,
	attention: 3,
});
// The same desk once nothing needs you.
const CALM = ready({
	total: 10,
	running: 7,
	working: 7,
	blocked: 2,
	waiting: 3,
	background: 1,
	attention: 3,
});

interface Tile {
	label: string;
	model: DashboardModel;
	mode: RenderMode;
	theme: Theme;
}

function keySvg(image: string): string {
	return Buffer.from(image.slice(image.indexOf(",") + 1), "base64").toString("utf8");
}

function escapeXml(value: string): string {
	return value.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** A grid of rendered keys with a caption under each, on the dark background OpenDeck uses. */
function sheet(rows: Tile[][]): string {
	const columns = Math.max(...rows.map((row) => row.length));
	const width = columns * KEY + (columns + 1) * GAP;
	const height = rows.length * (KEY + LABEL) + (rows.length + 1) * GAP;
	const tiles = rows.flatMap((row, rowIndex) =>
		row.map((tile, column) => {
			const x = GAP + column * (KEY + GAP);
			const y = GAP + rowIndex * (KEY + LABEL + GAP);
			const key = keySvg(renderKey(tile.model, tile.mode, tile.theme)).replace(
				/^<svg /,
				`<svg x="${x}" y="${y}" `,
			);
			const caption = `<text x="${x + KEY / 2}" y="${y + KEY + 20}" text-anchor="middle" fill="#97A5B0" font-family="DejaVu Sans, sans-serif" font-size="14">${escapeXml(tile.label)}</text>`;
			return `${key}\n${caption}`;
		}),
	);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n<rect width="${width}" height="${height}" fill="#0D0E10"/>\n${tiles.join("\n")}\n</svg>\n`;
}

const THEME_NAMES: Record<Theme, string> = {
	counter: "Counter",
	pictogram: "Pictogram",
	flood: "Flood",
	gauge: "Gauge",
	quad: "Quad",
};

const KEY_TYPES: Array<[RenderMode, string]> = [
	["combined", "Combined status"],
	["working", "Working threads"],
	["needs", "Needs you"],
	["question", "Questions"],
	["failed", "Failed threads"],
	["background", "Background tasks"],
	["waiting", "Waiting threads"],
	["overview", "Overview"],
];

const CONNECTION_STATES: Array<[DashboardModel, string]> = [
	[{ kind: "pairing" }, "Not paired"],
	[{ kind: "reauth" }, "Pairing expired"],
	[{ kind: "offline" }, "No machine reachable"],
	[{ kind: "unsupported" }, "Unsupported T3 version"],
];

/** Every docs image by file name. */
export function renderDocsImages(): Record<string, string> {
	return {
		"themes.svg": sheet(
			THEMES.map((theme) => [
				{ label: `${THEME_NAMES[theme]}: needs you`, model: BUSY, mode: "combined", theme },
				{ label: `${THEME_NAMES[theme]}: working`, model: CALM, mode: "combined", theme },
				{ label: `${THEME_NAMES[theme]}: Overview`, model: BUSY, mode: "overview", theme },
			]),
		),
		"key-types.svg": sheet([
			KEY_TYPES.slice(0, 4).map(([mode, label]) => ({ label, model: BUSY, mode, theme: "counter" })),
			KEY_TYPES.slice(4).map(([mode, label]) => ({ label, model: BUSY, mode, theme: "counter" })),
		]),
		"connection-states.svg": sheet([
			CONNECTION_STATES.map(([model, label]) => ({ label, model, mode: "combined", theme: "counter" })),
		]),
	};
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
	await mkdir(DOCS_IMAGE_DIRECTORY, { recursive: true });
	for (const [name, content] of Object.entries(renderDocsImages()))
		await writeFile(resolve(DOCS_IMAGE_DIRECTORY, name), content);
	console.log(`Wrote the docs images to ${DOCS_IMAGE_DIRECTORY}`);
}
