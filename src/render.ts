import type { DashboardModel, RenderMode, Theme, ThreadSummary } from "./types.js";

// Keys are about 2 cm wide, so every key shows one large numeral or glyph, and every colour has
// its own shape for colour-blind readers. Geometry follows mockups/key-mockups.html.
const C = {
	key: "#0E141A",
	ink: "#0B1116",
	well: "#1C262F",
	dim: "#4A5862",
	grey: "#97A5B0",
	white: "#F2F6F8",
	green: "#4CE08A",
	yellow: "#FFC83D",
	red: "#FF5A6E",
	cyan: "#48C8F5",
	violet: "#B48CFF",
	orange: "#FF9A3C",
} as const;

type Glyph =
	| "tri"
	| "bubble"
	| "bubbleCheck"
	| "bubbleQ"
	| "bubbleLines"
	| "cross"
	| "check"
	| "lines"
	| "q"
	| "gear"
	| "hourglass"
	| "pause"
	| "ring"
	| "dots"
	| "power"
	| "link"
	| "lock"
	| "warn"
	| "t3struck";

type StatusKey =
	| "working"
	| "needs"
	| "approval"
	| "question"
	| "plan"
	| "failed"
	| "limit"
	| "background"
	| "unseen"
	| "waiting"
	| "open"
	| "none";

const STATUS: Record<StatusKey, { color: string; glyph: Glyph }> = {
	working: { color: C.green, glyph: "tri" },
	needs: { color: C.yellow, glyph: "bubble" },
	approval: { color: C.yellow, glyph: "bubbleCheck" },
	question: { color: C.yellow, glyph: "bubbleQ" },
	plan: { color: C.yellow, glyph: "bubbleLines" },
	failed: { color: C.red, glyph: "cross" },
	limit: { color: C.violet, glyph: "hourglass" },
	background: { color: C.grey, glyph: "gear" },
	unseen: { color: C.cyan, glyph: "check" },
	waiting: { color: C.grey, glyph: "ring" },
	open: { color: C.grey, glyph: "ring" },
	none: { color: C.dim, glyph: "ring" },
};

type ConnectionKey = Exclude<DashboardModel["kind"], "ready">;

const CONNECTION: Record<ConnectionKey, { color: string; glyph: Glyph; word: string }> = {
	loading: { color: C.cyan, glyph: "dots", word: "" },
	offline: { color: C.grey, glyph: "power", word: "OFF" },
	pairing: { color: C.cyan, glyph: "link", word: "PAIR" },
	reauth: { color: C.orange, glyph: "lock", word: "RE-PAIR" },
	unsupported: { color: C.white, glyph: "t3struck", word: "VERSION" },
	error: { color: C.red, glyph: "warn", word: "ERROR" },
};

const BLINKING_MODES = new Set<RenderMode>(["combined", "needs", "approval", "question", "plan"]);

type SingleMode = Exclude<RenderMode, "combined" | "overview">;

/** The status and count a single-status key shows. */
interface Reading {
	status: StatusKey;
	count: number;
	blink: boolean;
}

function needsCount(summary: ThreadSummary): number {
	return summary.approval + summary.input + summary.plan;
}

function readingFor(mode: SingleMode, summary: ThreadSummary): Reading {
	switch (mode) {
		case "working":
			return { status: "working", count: summary.running, blink: false };
		case "needs":
			return { status: "needs", count: needsCount(summary), blink: true };
		case "approval":
			return { status: "approval", count: summary.approval, blink: true };
		case "question":
			return { status: "question", count: summary.input, blink: true };
		case "plan":
			return { status: "plan", count: summary.plan, blink: true };
		case "failed":
			return { status: "failed", count: summary.failed, blink: false };
		case "limit":
			return { status: "limit", count: summary.limited, blink: false };
		case "background":
			return { status: "background", count: summary.background, blink: false };
		case "waiting":
			return { status: "waiting", count: summary.waiting + summary.monitoring, blink: false };
	}
}

/** The most urgent state, which the combined key shows. */
function mostUrgent(summary: ThreadSummary): Reading {
	const needs = needsCount(summary);
	if (needs > 0) return { status: "needs", count: needs, blink: true };
	if (summary.failed > 0) return { status: "failed", count: summary.failed, blink: false };
	if (summary.limited > 0) return { status: "limit", count: summary.limited, blink: false };
	if (summary.unseen > 0) return { status: "unseen", count: summary.unseen, blink: false };
	if (summary.total === 0) return { status: "none", count: 0, blink: false };
	if (summary.running === 0) return { status: "open", count: 0, blink: false };
	return { status: "working", count: summary.running, blink: false };
}

/** Whether this key blinks for a pending approval, question, or plan review. */
export function isAlerting(model: DashboardModel, mode: RenderMode = "combined"): boolean {
	// The Overview key never blinks; it is for reading counts at a glance.
	if (model.kind !== "ready" || mode === "overview" || !BLINKING_MODES.has(mode)) return false;
	if (mode === "combined") return needsCount(model.summary) > 0;
	return readingFor(mode, model.summary).count > 0;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function getAccessibleTitle(model: DashboardModel, mode: RenderMode = "combined"): string {
	switch (model.kind) {
		case "loading":
			return "Loading T3 Code status";
		case "offline":
			return "T3 Code offline";
		case "error":
			return "T3 Code status error";
		case "pairing":
			return "Pair T3 Code in the OpenDeck key settings";
		case "reauth":
			return "T3 Code authorization expired. Pair again in the OpenDeck key settings";
		case "unsupported":
			return "Unsupported T3 Code version";
	}
	const { summary } = model;
	const needs = needsCount(summary);
	switch (mode) {
		case "working":
			return summary.total === 0
				? "No open T3 Code threads"
				: `${summary.running} of ${summary.total} threads working`;
		case "needs":
			return needs > 0
				? `${plural(needs, "thread needs", "threads need")} your input, approval, or plan review`
				: "No T3 Code questions pending";
		case "approval":
			return `${plural(summary.approval, "thread needs", "threads need")} your approval`;
		case "question":
			return `${plural(summary.input, "thread asks", "threads ask")} you a question`;
		case "plan":
			return `${plural(summary.plan, "plan is", "plans are")} ready for review`;
		case "failed":
			return `${plural(summary.failed, "thread", "threads")} failed`;
		case "limit":
			return `${plural(summary.limited, "thread is", "threads are")} paused by a usage limit`;
		case "background":
			return `${plural(summary.background, "thread has", "threads have")} background tasks`;
		case "waiting":
			return `${plural(summary.waiting + summary.monitoring, "thread is", "threads are")} waiting`;
	}
	if (summary.total === 0) return "No open T3 Code threads";
	const working = `${summary.running} of ${summary.total} working`;
	const details = [
		summary.failed > 0 ? plural(summary.failed, "error", "errors") : "",
		needs > 0 ? `${plural(needs, "needs", "need")} your attention` : "",
		summary.limited > 0 ? `${summary.limited} paused by a usage limit` : "",
		summary.unseen > 0 ? `${summary.unseen} done, not seen` : "",
	].filter(Boolean);
	if (details.length > 0) return `${working}, ${details.join(", ")}`;
	if (summary.attention > 0) return `${working}, ${summary.attention} waiting`;
	return `${summary.running} of ${plural(summary.total, "thread", "threads")} working`;
}

export function renderKey(
	model: DashboardModel,
	mode: RenderMode = "combined",
	theme: Theme = "counter",
	alertPhase = false,
): string {
	const draw = THEME_RENDERERS[theme];
	if (model.kind !== "ready") return svgData(draw.connection(model.kind));
	const frame = alertPhase && isAlerting(model, mode);
	if (mode === "combined") return svgData(draw.combined(model.summary, frame));
	if (mode === "overview") return svgData(draw.overview(model.summary));
	return svgData(draw.single(mode, readingFor(mode, model.summary), model.summary, frame));
}

interface ThemeRenderer {
	combined(summary: ThreadSummary, frame: boolean): string;
	single(mode: SingleMode, reading: Reading, summary: ThreadSummary, frame: boolean): string;
	/** Several counts on one key: working, needs you, failed, and limits or background tasks. */
	overview(summary: ThreadSummary): string;
	connection(kind: ConnectionKey): string;
}

// ---------- shared drawing ----------

const f = (value: number) => (Math.round(value * 10) / 10).toString();

function text(
	x: number,
	y: number,
	value: string,
	size: number,
	fill: string,
	options: { anchor?: "start" | "middle" | "end"; spacing?: number } = {},
): string {
	const spacing = options.spacing ? ` letter-spacing="${options.spacing}"` : "";
	return `<text x="${f(x)}" y="${f(y)}" text-anchor="${options.anchor ?? "middle"}" fill="${fill}" font-family="DejaVu Sans, sans-serif" font-size="${f(size)}" font-weight="bold"${spacing}>${escapeXml(value)}</text>`;
}

/** One digit gets `one`; longer counts share the width two digits get at `two`, so 100 still fits. */
function numeralSize(count: number, one: number, two: number): number {
	const digits = String(count).length;
	return digits === 1 ? one : (two * 2) / Math.max(2, digits);
}
const background = (fill: string) => `<rect width="144" height="144" rx="17" fill="${fill}"/>`;

function mix(from: string, to: string, amount: number): string {
	const channels = (hex: string) =>
		[1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
	const a = channels(from);
	const b = channels(to);
	return `#${a
		.map((value, index) =>
			Math.round(value + ((b[index] ?? value) - value) * amount)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")
		.toUpperCase()}`;
}

/** How a key reads: its blink frame, an empty count, an idle state, or a live count. */
type Tone = "frame" | "zero" | "idle" | "live";

function toneOf(frame: boolean, zero: boolean, idle: boolean): Tone {
	if (frame) return "frame";
	if (zero) return "zero";
	return idle ? "idle" : "live";
}

function bubblePath(cx: number, cy: number, s: number): string {
	const w = s;
	const h = 0.76 * s;
	const r = 0.2 * s;
	const x0 = cx - w / 2;
	const y0 = cy - h / 2 - 0.08 * s;
	const yb = y0 + h;
	return `M${f(x0 + r)} ${f(y0)} H${f(x0 + w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(x0 + w)} ${f(y0 + r)} V${f(yb - r)} A${f(r)} ${f(r)} 0 0 1 ${f(x0 + w - r)} ${f(yb)} H${f(x0 + 0.46 * w)} L${f(x0 + 0.2 * w)} ${f(yb + 0.2 * s)} L${f(x0 + 0.27 * w)} ${f(yb)} H${f(x0 + r)} A${f(r)} ${f(r)} 0 0 1 ${f(x0)} ${f(yb - r)} V${f(y0 + r)} A${f(r)} ${f(r)} 0 0 1 ${f(x0 + r)} ${f(y0)} Z`;
}

const BUBBLE_INNER: Partial<Record<Glyph, Glyph>> = {
	bubbleCheck: "check",
	bubbleQ: "q",
	bubbleLines: "lines",
};

function glyph(name: Glyph, cx: number, cy: number, s: number, color: string, bg: string = C.key): string {
	const p = (x: number, y: number) => `${f(x)},${f(y)}`;
	const line = (x1: number, y1: number, x2: number, y2: number, width: number, stroke = color) =>
		`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${stroke}" stroke-width="${f(width)}" stroke-linecap="round"/>`;
	switch (name) {
		case "tri":
			return `<polygon points="${p(cx - 0.38 * s, cy - 0.48 * s)} ${p(cx + 0.5 * s, cy)} ${p(cx - 0.38 * s, cy + 0.48 * s)}" fill="${color}" stroke="${color}" stroke-width="${f(0.1 * s)}" stroke-linejoin="round"/>`;
		case "cross":
			return (
				line(cx - 0.36 * s, cy - 0.36 * s, cx + 0.36 * s, cy + 0.36 * s, 0.2 * s) +
				line(cx + 0.36 * s, cy - 0.36 * s, cx - 0.36 * s, cy + 0.36 * s, 0.2 * s)
			);
		case "check":
			return `<path d="M${f(cx - 0.42 * s)} ${f(cy + 0.02 * s)} L${f(cx - 0.12 * s)} ${f(cy + 0.32 * s)} L${f(cx + 0.44 * s)} ${f(cy - 0.32 * s)}" fill="none" stroke="${color}" stroke-width="${f(0.2 * s)}" stroke-linecap="round" stroke-linejoin="round"/>`;
		case "lines":
			return [-0.3, 0, 0.3]
				.map((k) => line(cx - 0.38 * s, cy + k * s, cx + 0.38 * s, cy + k * s, 0.16 * s))
				.join("");
		case "q":
			return text(cx, cy + 0.4 * s, "?", 1.15 * s, color);
		case "ring":
			return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(0.38 * s)}" fill="none" stroke="${color}" stroke-width="${f(0.16 * s)}"/>`;
		case "gear": {
			const points: string[] = [];
			for (let k = 0; k < 32; k++) {
				const angle = ((k * 11.25 - 90) * Math.PI) / 180;
				const radius = k % 4 < 2 ? 0.5 * s : 0.37 * s;
				points.push(p(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)));
			}
			return `<polygon points="${points.join(" ")}" fill="${color}" stroke="${color}" stroke-width="${f(0.05 * s)}" stroke-linejoin="round"/><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(0.15 * s)}" fill="${bg}"/>`;
		}
		case "pause":
			return [-0.22, 0.22]
				.map(
					(k) =>
						`<rect x="${f(cx + k * s - 0.12 * s)}" y="${f(cy - 0.4 * s)}" width="${f(0.24 * s)}" height="${f(0.8 * s)}" rx="${f(0.06 * s)}" fill="${color}"/>`,
				)
				.join("");
		case "hourglass":
			return `<polygon points="${p(cx - 0.42 * s, cy - 0.5 * s)} ${p(cx + 0.42 * s, cy - 0.5 * s)} ${p(cx + 0.42 * s, cy - 0.4 * s)} ${p(cx + 0.07 * s, cy)} ${p(cx + 0.42 * s, cy + 0.4 * s)} ${p(cx + 0.42 * s, cy + 0.5 * s)} ${p(cx - 0.42 * s, cy + 0.5 * s)} ${p(cx - 0.42 * s, cy + 0.4 * s)} ${p(cx - 0.07 * s, cy)} ${p(cx - 0.42 * s, cy - 0.4 * s)}" fill="${color}" stroke="${color}" stroke-width="${f(0.06 * s)}" stroke-linejoin="round"/>`;
		case "dots":
			return [-0.34, 0, 0.34]
				.map((k) => `<circle cx="${f(cx + k * s)}" cy="${f(cy)}" r="${f(0.11 * s)}" fill="${color}"/>`)
				.join("");
		case "power": {
			const r = 0.4 * s;
			const a = (35 * Math.PI) / 180;
			const sx = cx - r * Math.sin(a);
			const sy = cy - r * Math.cos(a);
			const ex = cx + r * Math.sin(a);
			return `<path d="M${f(sx)} ${f(sy)} A${f(r)} ${f(r)} 0 1 0 ${f(ex)} ${f(sy)}" fill="none" stroke="${color}" stroke-width="${f(0.14 * s)}" stroke-linecap="round"/>${line(cx, cy - 0.52 * s, cx, cy - 0.02 * s, 0.14 * s)}`;
		}
		case "link": {
			const w = 0.64 * s;
			const h = 0.3 * s;
			const link = (x: number) =>
				`<rect x="${f(x)}" y="${f(cy - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(h / 2)}" fill="none" stroke="${color}" stroke-width="${f(0.11 * s)}" transform="rotate(-45 ${f(cx)} ${f(cy)})"/>`;
			return link(cx - 0.58 * s) + link(cx - 0.06 * s);
		}
		case "lock":
			return `<rect x="${f(cx - 0.36 * s)}" y="${f(cy - 0.02 * s)}" width="${f(0.72 * s)}" height="${f(0.52 * s)}" rx="${f(0.08 * s)}" fill="${color}"/><path d="M${f(cx + 0.2 * s)} ${f(cy - 0.02 * s)} V${f(cy - 0.26 * s)} A${f(0.2 * s)} ${f(0.2 * s)} 0 0 0 ${f(cx - 0.2 * s)} ${f(cy - 0.26 * s)} V${f(cy - 0.18 * s)}" fill="none" stroke="${color}" stroke-width="${f(0.11 * s)}" stroke-linecap="round"/><circle cx="${f(cx)}" cy="${f(cy + 0.22 * s)}" r="${f(0.07 * s)}" fill="${bg}"/>`;
		case "warn":
			return `<polygon points="${p(cx, cy - 0.5 * s)} ${p(cx + 0.54 * s, cy + 0.42 * s)} ${p(cx - 0.54 * s, cy + 0.42 * s)}" fill="${color}" stroke="${color}" stroke-width="${f(0.1 * s)}" stroke-linejoin="round"/>${text(cx, cy + 0.34 * s, "!", 0.62 * s, bg)}`;
		case "t3struck":
			return (
				text(cx, cy + 0.27 * s, "T3", 0.74 * s, color) +
				line(cx - 0.44 * s, cy + 0.42 * s, cx + 0.44 * s, cy - 0.42 * s, 0.22 * s, bg) +
				line(cx - 0.44 * s, cy + 0.42 * s, cx + 0.44 * s, cy - 0.42 * s, 0.1 * s)
			);
		case "bubble":
		case "bubbleCheck":
		case "bubbleQ":
		case "bubbleLines": {
			const inner = BUBBLE_INNER[name];
			// The inner mark is cut out of the bubble: drawn in the key colour on the bubble colour.
			const cutout = { ink: bg, under: color };
			const bubble = `<path d="${bubblePath(cx, cy, s)}" fill="${cutout.under}"/>`;
			return inner ? bubble + glyph(inner, cx, cy - 0.08 * s, 0.42 * s, cutout.ink, cutout.under) : bubble;
		}
	}
}

function pill(
	value: string,
	fill: string,
	ink: string,
	box: { x: number; y: number; h: number; size: number; spacing?: number },
	width: number,
): string {
	return `<rect x="${f(box.x)}" y="${box.y}" width="${width}" height="${box.h}" rx="${box.h / 2}" fill="${fill}" stroke="${C.key}" stroke-width="5"/>${text(box.x + width / 2, box.y + box.h / 2 + 0.365 * box.size, value, box.size, ink, box.spacing ? { spacing: box.spacing } : {})}`;
}

/** A count pill in a corner; long values such as `100/100` shrink their text to stay on the key. */
const MAX_PILL_WIDTH = 136;

function cornerPill(value: string, fill: string, ink: string, top: boolean): string {
	const size = Math.min(30, (MAX_PILL_WIDTH - 22) / (value.length * 0.7));
	const width = Math.round(value.length * 0.7 * size + 22);
	return pill(value, fill, ink, { x: 140 - width, y: top ? 4 : 98, h: 42, size }, width);
}

function wordPill(word: string, fill: string, y = 104): string {
	const width = Math.round(word.length * 0.68 * 22 + 26);
	return pill(word, fill, C.ink, { x: 72 - width / 2, y, h: 34, size: 22, spacing: 1 }, width);
}

const band = (fill: string) =>
	`<rect x="0" y="106" width="144" height="38" rx="17" fill="${fill}"/><rect x="0" y="106" width="144" height="19" fill="${fill}"/>`;

// ---------- overview key: four counts in fixed cells ----------

/**
 * One cell. For running threads, `count` is the active ones and `waiting` the rest, so the two
 * add up to the running total instead of reading as one count inside the other.
 */
type Cell = (x: number, y: number, status: StatusKey, count: number, waiting: number) => string;

/** Running (active, plus those that only wait) and needs you on top, done but not seen and errors below. */
function overviewKey(summary: ThreadSummary, cell: Cell): string {
	const cells: Array<[StatusKey, number, number]> = [
		["working", summary.running - summary.blocked, summary.blocked],
		["needs", needsCount(summary), 0],
		["unseen", summary.unseen, 0],
		["failed", summary.failed + summary.limited, 0],
	];
	return (
		background(C.key) +
		cells
			.map(([status, count, waiting], index) =>
				cell(index % 2 === 0 ? 5 : 74, index < 2 ? 5 : 74, status, count, waiting),
			)
			.join("")
	);
}

// ---------- 1 · Counter: big numeral and a colour band ----------

function counterKey(
	status: StatusKey,
	count: number,
	frame: boolean,
	options: { total?: number; zero?: boolean },
) {
	const color = STATUS[status].color;
	const tone = toneOf(frame, options.zero === true, status === "none" || status === "open");
	const bandFill = { frame: C.ink, zero: C.well, idle: C.well, live: color }[tone];
	const glyphColor = { frame: color, zero: mix(color, C.well, 0.45), idle: C.grey, live: C.ink }[tone];
	const size = numeralSize(count, 104, 86);
	let svg = background(frame ? color : C.key);
	svg += band(bandFill);
	svg += glyph(STATUS[status].glyph, 27, 125, 24, glyphColor, bandFill);
	if (options.total !== undefined)
		svg += text(
			134,
			136,
			String(options.total),
			30,
			{ frame: color, zero: C.grey, idle: C.grey, live: C.ink }[tone],
			{
				anchor: "end",
			},
		);
	const countColor = { frame: C.ink, zero: C.dim, idle: C.dim, live: color }[tone];
	return svg + text(72, 56 + 0.365 * size, String(count), size, countColor);
}

const counter: ThemeRenderer = {
	combined(summary, frame) {
		const { status, count } = mostUrgent(summary);
		return counterKey(status, count, frame, { total: summary.total });
	},
	single(mode, reading, summary, frame) {
		return counterKey(reading.status, reading.count, frame, {
			zero: reading.count === 0,
			...(mode === "working" ? { total: summary.total } : {}),
		});
	},
	connection(kind) {
		const { color, glyph: name, word } = CONNECTION[kind];
		const svg = background(C.key) + band(word ? color : C.well) + glyph(name, 72, 54, 64, color);
		return word ? svg + text(72, 134, word, 24, C.ink, { spacing: 1 }) : svg;
	},
	overview(summary) {
		return overviewKey(summary, (x, y, status, count, waiting) => {
			const color = STATUS[status].color;
			const lit = count + waiting > 0;
			const bandFill = lit ? color : C.well;
			let svg = `<rect x="${x}" y="${y + 46}" width="65" height="19" rx="6" fill="${bandFill}"/>`;
			svg += glyph(STATUS[status].glyph, x + 12, y + 55.5, 13, lit ? C.ink : C.dim, bandFill);
			if (waiting > 0)
				svg +=
					glyph("pause", x + 38, y + 55.5, 12, C.ink, bandFill) +
					text(x + 55, y + 55.5 + 0.365 * 15, String(waiting), numeralSize(waiting, 15, 15), C.ink);
			const size = numeralSize(count, 40, 32);
			return svg + text(x + 32.5, y + 23 + 0.365 * size, String(count), size, count > 0 ? color : C.dim);
		});
	},
};

// ---------- 2 · Pictogram: large icon and a count pill ----------

const BUBBLE_STATUSES = new Set<StatusKey>(["needs", "approval", "question", "plan"]);
const BUBBLE_GLYPHS: Partial<Record<StatusKey, Glyph>> = { approval: "check", question: "q", plan: "lines" };

type PictogramOptions = { zero?: boolean; badge?: string; badgeFill?: string; badgeInk?: string };

function pictogramKey(status: StatusKey, count: number, frame: boolean, options: PictogramOptions): string {
	const color = STATUS[status].color;
	if (BUBBLE_STATUSES.has(status)) return bubbleKey(status, count, frame, options);
	let svg = background(C.key);
	svg += glyph(
		STATUS[status].glyph,
		status === "working" ? 78 : 72,
		74,
		94,
		options.zero ? mix(color, C.key, 0.55) : color,
	);
	if (options.badge !== undefined && !options.zero)
		svg += cornerPill(options.badge, options.badgeFill ?? color, options.badgeInk ?? C.ink, true);
	return svg;
}

/** Request keys draw a speech bubble; the bubble sits high-left so the count pill clears its tail. */
function bubbleKey(status: StatusKey, count: number, frame: boolean, options: PictogramOptions): string {
	const color = STATUS[status].color;
	const faded = mix(color, C.key, 0.55);
	const tone = options.zero ? "zero" : toneOf(frame, false, false);
	const fill = tone === "live" ? color : C.key;
	const stroke = {
		width: { frame: 8, zero: 6, idle: 0, live: 0 }[tone],
		color: options.zero ? faded : color,
	};
	const inner = { frame: color, zero: faded, idle: C.ink, live: C.ink }[tone];
	let svg = `${background(C.key)}<path d="${bubblePath(66, 60, 100)}" fill="${fill}" stroke="${stroke.color}" stroke-width="${stroke.width}" stroke-linejoin="round"/>`;
	const subtype = BUBBLE_GLYPHS[status];
	const size = numeralSize(count, 76, 62);
	svg += subtype
		? glyph(subtype, 66, 52, 44, inner, fill)
		: text(66, 52 + 0.365 * size, String(count), size, inner);
	if (options.badge !== undefined && !options.zero)
		svg += cornerPill(options.badge, options.badgeFill ?? color, options.badgeInk ?? C.ink, false);
	return svg;
}

const pictogram: ThemeRenderer = {
	combined(summary, frame) {
		const { status, count } = mostUrgent(summary);
		const ratio = `${summary.running}/${summary.total}`;
		if (status === "needs")
			return pictogramKey(status, count, frame, { badge: ratio, badgeFill: C.well, badgeInk: C.white });
		if (status === "working") return pictogramKey(status, count, frame, { badge: ratio });
		if (status === "open" || status === "none")
			return pictogramKey(status, count, frame, { badge: ratio, badgeFill: C.well, badgeInk: C.grey });
		return pictogramKey(status, count, frame, { badge: String(count) });
	},
	single(_mode, reading, _summary, frame) {
		return pictogramKey(reading.status, reading.count, frame, {
			zero: reading.count === 0,
			badge: String(reading.count),
		});
	},
	connection(kind) {
		const { color, glyph: name, word } = CONNECTION[kind];
		const svg = background(C.key) + glyph(name, 72, word ? 58 : 72, 72, color);
		return word ? svg + wordPill(word, color) : svg;
	},
	overview(summary) {
		return overviewKey(summary, (x, y, status, count, waiting) => {
			const color = STATUS[status].color;
			const lit = count + waiting > 0;
			let svg = glyph(
				STATUS[status].glyph,
				x + (waiting > 0 ? 22 : 32.5),
				y + 24,
				30,
				lit ? color : mix(color, C.key, 0.55),
			);
			if (waiting > 0)
				svg +=
					glyph("pause", x + 51, y + 16, 14, C.grey) +
					text(x + 51, y + 33 + 0.365 * 14, String(waiting), numeralSize(waiting, 14, 14), C.grey);
			const size = numeralSize(count, 24, 22);
			return svg + text(x + 32.5, y + 54 + 0.365 * size, String(count), size, count > 0 ? C.white : C.dim);
		});
	},
};

// ---------- 3 · Flood: the whole key is the status colour ----------

function floodKey(
	status: StatusKey,
	count: number,
	frame: boolean,
	options: { total?: number; zero?: boolean },
) {
	const color = STATUS[status].color;
	if (options.zero)
		return background(C.key) + glyph(STATUS[status].glyph, 72, 72, 60, mix(color, C.key, 0.55));
	const tone = status === "none" || status === "open" ? "idle" : toneOf(frame, false, false);
	const fill = { frame: C.ink, zero: color, idle: C.well, live: color }[tone];
	const ink = { frame: color, zero: C.ink, idle: C.grey, live: C.ink }[tone];
	let svg = background(fill) + glyph(STATUS[status].glyph, 28, 28, 28, ink, fill);
	if (options.total !== undefined) {
		const size = numeralSize(count, 100, 84);
		svg += text(78, (size > 90 ? 70 : 74) + 0.365 * size, String(count), size, ink);
		return svg + text(136, 134, `/${options.total}`, 36, ink, { anchor: "end" });
	}
	const size = numeralSize(count, 108, 90);
	return svg + text(76, 80 + 0.365 * size, String(count), size, ink);
}

const flood: ThemeRenderer = {
	combined(summary, frame) {
		const { status, count } = mostUrgent(summary);
		const calm = status === "working" || status === "open" || status === "none";
		return floodKey(status, count, frame, calm ? { total: summary.total } : {});
	},
	single(mode, reading, summary, frame) {
		return floodKey(reading.status, reading.count, frame, {
			zero: reading.count === 0,
			...(mode === "working" ? { total: summary.total } : {}),
		});
	},
	connection(kind) {
		const { color, glyph: name, word } = CONNECTION[kind];
		if (!word) return background(C.key) + glyph(name, 72, 72, 64, color);
		return (
			background(color) +
			glyph(name, 72, 58, 62, C.ink, color) +
			text(72, 128, word, 24, C.ink, { spacing: 1 })
		);
	},
	overview(summary) {
		return overviewKey(summary, (x, y, status, count, waiting) => {
			const color = STATUS[status].color;
			if (count + waiting === 0)
				return `<rect x="${x}" y="${y}" width="65" height="65" rx="9" fill="${C.key}" stroke="${C.well}" stroke-width="2"/>${glyph(STATUS[status].glyph, x + 32.5, y + 32.5, 24, mix(color, C.key, 0.55))}`;
			let svg = `<rect x="${x}" y="${y}" width="65" height="65" rx="9" fill="${color}"/>`;
			svg += glyph(STATUS[status].glyph, x + 13, y + 13, 14, C.ink, color);
			if (waiting > 0)
				svg +=
					glyph("pause", x + 42, y + 13, 12, C.ink, color) +
					text(x + 60, y + 13 + 0.365 * 15, String(waiting), 15, C.ink, { anchor: "end" });
			const size = numeralSize(count, 46, 38);
			const two = String(count).length >= 2;
			const ink = count > 0 ? C.ink : mix(C.ink, color, 0.55);
			return (
				svg + text(x + (two ? 34.5 : 37.5), y + (two ? 41 : 39) + 0.365 * size, String(count), size, ink)
			);
		});
	},
};

// ---------- 4 · Gauge: one ring segment per open thread ----------

type Category = "working" | "approval" | "question" | "plan" | "failed" | "limit" | "waiting";
const CATEGORY_COLOR: Record<Category, string> = {
	working: C.green,
	approval: C.yellow,
	question: C.yellow,
	plan: C.yellow,
	failed: C.red,
	limit: C.violet,
	waiting: C.dim,
};

function categoryCounts(summary: ThreadSummary): Array<[Category, number]> {
	return [
		["working", summary.running],
		["approval", summary.approval],
		["question", summary.input],
		["plan", summary.plan],
		["failed", summary.failed],
		["limit", summary.limited],
		["waiting", summary.waiting + summary.monitoring],
	];
}

interface Segment {
	color: string;
	weight: number;
}

interface Circle {
	cx: number;
	cy: number;
	r: number;
	width: number;
}

const KEY_RING: Circle = { cx: 72, cy: 72, r: 60, width: 14 };

function arc(circle: Circle, from: number, span: number, color: string): string {
	const { cx, cy, r, width } = circle;
	if (span >= 359.9)
		return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${r}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
	const polar = (degrees: number) => {
		const angle = (degrees * Math.PI) / 180;
		return `${f(cx + r * Math.cos(angle))} ${f(cy + r * Math.sin(angle))}`;
	};
	return `<path d="M${polar(from)} A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${polar(from + span)}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
}

function ring(segments: Segment[], circle: Circle = KEY_RING, gap = 4): string {
	const total = segments.reduce((sum, segment) => sum + segment.weight, 0);
	if (total === 0) return arc(circle, 0, 360, C.well);
	const gaps = segments.length > 1 ? segments.length * gap : 0;
	const perUnit = (360 - gaps) / total;
	let angle = -90 + (segments.length > 1 ? gap / 2 : 0);
	let svg = "";
	for (const segment of segments) {
		const span = segment.weight * perUnit;
		svg += arc(circle, angle, span, segment.color);
		angle += span + gap;
	}
	return svg;
}

/** One segment per thread up to 12 threads, then one proportional arc per colour run. */
function threadSegments(summary: ThreadSummary, colorFor: (category: Category) => string): Segment[] {
	const colors = categoryCounts(summary).flatMap(([category, count]) =>
		Array.from({ length: count }, () => colorFor(category)),
	);
	if (colors.length <= 12) return colors.map((color) => ({ color, weight: 1 }));
	const segments: Segment[] = [];
	for (const color of colors) {
		const last = segments.at(-1);
		if (last?.color === color) last.weight += 1;
		else segments.push({ color, weight: 1 });
	}
	return segments;
}

const GAUGE_SUBSET: Partial<Record<RenderMode, Category[]>> = {
	working: ["working"],
	needs: ["approval", "question", "plan"],
	approval: ["approval"],
	question: ["question"],
	plan: ["plan"],
	failed: ["failed"],
	limit: ["limit"],
	waiting: ["waiting"],
};

function gaugeKey(
	status: StatusKey,
	count: number,
	frame: boolean,
	segments: Segment[],
	zero = false,
): string {
	const color = STATUS[status].color;
	const tone = toneOf(frame, zero, status === "none" || status === "open");
	let svg = background(C.key) + ring(segments);
	if (frame) svg += `<circle cx="72" cy="72" r="51" fill="${color}"/>`;
	const size = numeralSize(count, 80, 66);
	svg += text(
		72,
		60 + 0.365 * size,
		String(count),
		size,
		{ frame: C.ink, zero: C.dim, idle: C.dim, live: color }[tone],
	);
	const glyphColor = { frame: C.ink, zero: mix(color, C.key, 0.5), idle: C.grey, live: color }[tone];
	return svg + glyph(STATUS[status].glyph, 72, 112, 24, glyphColor, frame ? color : C.key);
}

const gauge: ThemeRenderer = {
	combined(summary, frame) {
		const { status, count } = mostUrgent(summary);
		return gaugeKey(
			status,
			count,
			frame,
			threadSegments(summary, (category) => CATEGORY_COLOR[category]),
		);
	},
	single(mode, reading, summary, frame) {
		const color = STATUS[reading.status].color;
		const subset = GAUGE_SUBSET[mode];
		let segments: Segment[] = [];
		if (subset)
			segments = threadSegments(summary, (category) => (subset.includes(category) ? color : C.well));
		else if (summary.total > 0)
			segments = [
				{ color, weight: summary.background },
				{ color: C.well, weight: summary.total - summary.background },
			].filter((segment) => segment.weight > 0);
		return gaugeKey(reading.status, reading.count, frame, segments, reading.count === 0);
	},
	connection(kind) {
		const { color, glyph: name, word } = CONNECTION[kind];
		let svg = `${background(C.key)}<circle cx="72" cy="72" r="60" fill="none" stroke="${color}" stroke-width="14"${kind === "loading" ? ' stroke-dasharray="14 9"' : ""}/>`;
		svg += glyph(name, 72, word ? 62 : 72, 50, color);
		return word ? svg + wordPill(word, color, 106) : svg;
	},
	overview(summary) {
		return overviewKey(summary, (x, y, status, count, waiting) => {
			const color = STATUS[status].color;
			const lit = count + waiting > 0;
			const circle: Circle = { cx: x + 32.5, cy: y + 32.5, r: 26, width: 7 };
			let svg = arc(circle, 0, 360, C.well);
			if (lit && summary.total > 0) {
				const span = 360 * Math.min(1, (count + waiting) / summary.total);
				const active = (span * count) / (count + waiting);
				svg += arc(circle, -90, active, color);
				// The waiting part of the running count continues the arc in grey.
				if (waiting > 0) svg += arc(circle, -90 + active, span - active, C.grey);
			}
			const size = numeralSize(count, 24, 21);
			svg += text(circle.cx, circle.cy - 2 + 0.365 * size, String(count), size, count > 0 ? color : C.dim);
			return (
				svg + glyph(STATUS[status].glyph, circle.cx, circle.cy + 14, 11, lit ? color : mix(color, C.key, 0.5))
			);
		});
	},
};

// ---------- 5 · Quad: counters in boxes ----------

function quadCell(x: number, y: number, status: StatusKey, count: number, waiting: number): string {
	const color = STATUS[status].color;
	if (count + waiting === 0)
		return `<rect x="${x}" y="${y}" width="65" height="65" rx="9" fill="${C.key}" stroke="${C.well}" stroke-width="2"/>${glyph(STATUS[status].glyph, x + 32.5, y + 32.5, 22, mix(color, C.key, 0.6))}`;
	const size = numeralSize(count, 52, 42);
	// Two digits shift left and down so they stay inside the cell and clear the corner shapes.
	const two = String(count).length >= 2;
	let svg = `<rect x="${x}" y="${y}" width="65" height="65" rx="9" fill="${C.well}"/>${glyph(STATUS[status].glyph, x + 13, y + 13, 14, color, C.well)}`;
	if (waiting > 0)
		svg +=
			glyph("pause", x + 42, y + 13, 12, C.grey, C.well) +
			text(x + 60, y + 13 + 0.365 * 15, String(waiting), 15, C.grey, { anchor: "end" });
	return (
		svg +
		text(
			x + (two ? 33.5 : 37.5),
			y + (two ? 40.5 : 38.5) + 0.365 * size,
			String(count),
			size,
			count > 0 ? color : C.dim,
		)
	);
}

/** One status per key: the shape top left and a full-size numeral. */
function quadKey(status: StatusKey, count: number, frame: boolean): string {
	const color = STATUS[status].color;
	const tone = toneOf(frame, count === 0, false);
	const fill = frame ? color : C.key;
	const size = numeralSize(count, 104, 86);
	return (
		background(fill) +
		glyph(
			STATUS[status].glyph,
			28,
			28,
			34,
			{ frame: C.ink, zero: mix(color, C.key, 0.5), idle: color, live: color }[tone],
			fill,
		) +
		text(
			80,
			80 + 0.365 * size,
			String(count),
			size,
			{ frame: C.ink, zero: C.dim, idle: color, live: color }[tone],
		)
	);
}

const quad: ThemeRenderer = {
	combined(summary, frame) {
		const { status, count } = mostUrgent(summary);
		return quadKey(status, status === "open" ? summary.total : count, frame);
	},
	single(_mode, reading, _summary, frame) {
		return quadKey(reading.status, reading.count, frame);
	},
	connection(kind) {
		const { color, glyph: name, word } = CONNECTION[kind];
		const svg = background(C.key) + glyph(name, 72, word ? 58 : 72, 60, color);
		return word ? svg + text(72, 128, word, 24, color, { spacing: 1 }) : svg;
	},
	overview(summary) {
		return overviewKey(summary, quadCell);
	},
};

const THEME_RENDERERS: Record<Theme, ThemeRenderer> = { counter, pictogram, flood, gauge, quad };

function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const replacements: Record<string, string> = {
			'"': "&quot;",
			"&": "&amp;",
			"'": "&apos;",
			"<": "&lt;",
			">": "&gt;",
		};
		return replacements[character] ?? character;
	});
}

function svgData(content: string): string {
	const document = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${content}</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(document).toString("base64")}`;
}
