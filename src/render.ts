import type { DashboardModel, ThreadSummary } from "./types.js";

const COLORS = {
	cyan: "#51D7E8",
	green: "#63E6BE",
	ink: "#071014",
	muted: "#6F858E",
	paper: "#F2F7F8",
	red: "#FF667D",
	slate: "#17262C",
	yellow: "#FFBE55",
} as const;

type Rgb = readonly [red: number, green: number, blue: number];

const STATUS_COLORS = {
	green: [99, 230, 190],
	red: [255, 102, 125],
	yellow: [255, 190, 85],
} as const satisfies Record<string, Rgb>;

interface Display {
	accent: string;
	count: string;
	footer: string;
	footerAccent?: string;
	label: string;
}

export function getDisplay(model: DashboardModel): Display {
	if (model.kind === "ready") return readyDisplay(model.summary);
	if (model.kind === "loading") {
		return { accent: COLORS.cyan, count: "···", footer: "LOADING", label: "T3 CODE" };
	}
	if (model.kind === "offline") {
		return { accent: COLORS.muted, count: "OFF", footer: "T3 OFFLINE", label: "T3 CODE" };
	}
	return { accent: COLORS.red, count: "ERR", footer: "STATUS ERROR", label: "T3 CODE" };
}

function readyDisplay(summary: ThreadSummary): Display {
	const accent = runningAccent(summary.running, summary.total);
	const count = `${summary.running}/${summary.total}`;
	if (summary.failed > 0) {
		return {
			accent,
			count,
			footer: `${summary.failed} ${summary.failed === 1 ? "ERROR" : "ERRORS"}`,
			footerAccent: COLORS.red,
			label: "T3 CODE",
		};
	}
	const directAttention = summary.approval + summary.input + summary.plan;
	if (directAttention > 0) {
		return {
			accent,
			count,
			footer: `${directAttention} ${directAttention === 1 ? "NEEDS YOU" : "NEED YOU"}`,
			label: "T3 CODE",
		};
	}
	if (summary.attention > 0) {
		return {
			accent,
			count,
			footer: `${summary.attention} WAITING`,
			label: "T3 CODE",
		};
	}
	if (summary.total === 0) {
		return { accent: COLORS.muted, count: "0/0", footer: "NO THREADS", label: "T3 CODE" };
	}
	return { accent, count, footer: "ALL WORKING", label: "T3 CODE" };
}

function runningAccent(running: number, total: number): string {
	if (total <= 0) return COLORS.green;
	const ratio = Math.min(1, Math.max(0, running / total));
	if (ratio <= 0.5) return interpolateColor(STATUS_COLORS.red, STATUS_COLORS.yellow, ratio * 2);
	return interpolateColor(STATUS_COLORS.yellow, STATUS_COLORS.green, (ratio - 0.5) * 2);
}

function interpolateColor(from: Rgb, to: Rgb, amount: number): string {
	const channel = (start: number, end: number) =>
		Math.round(start + (end - start) * amount)
			.toString(16)
			.padStart(2, "0")
			.toUpperCase();
	return `#${channel(from[0], to[0])}${channel(from[1], to[1])}${channel(from[2], to[2])}`;
}

export function renderDashboard(model: DashboardModel, progress: number): string {
	const display = getDisplay(model);
	const boundedProgress = Math.min(1, Math.max(0, progress));
	const radius = 61;
	const circumference = 2 * Math.PI * radius;
	const dashOffset = circumference * (1 - boundedProgress);
	const markerAngle = boundedProgress * Math.PI * 2 - Math.PI / 2;
	const markerX = 72 + radius * Math.cos(markerAngle);
	const markerY = 72 + radius * Math.sin(markerAngle);
	const countSize = display.count.length <= 3 ? 34 : Math.max(14, Math.floor(115 / display.count.length));
	const footerSize = display.footer.length >= 13 ? 10 : display.footer.length >= 12 ? 11 : 12;
	const footerSpacing = display.footer.length >= 13 ? 0.3 : display.footer.length >= 12 ? 0.4 : 0.6;

	return svgData(`
		<rect width="144" height="144" rx="17" fill="${COLORS.ink}"/>
		<circle cx="72" cy="72" r="${radius}" fill="none" stroke="${COLORS.slate}" stroke-width="5"/>
		<circle cx="72" cy="72" r="${radius}" fill="none" stroke="${display.accent}" stroke-width="5"
			stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}"
			stroke-dashoffset="${dashOffset.toFixed(2)}" transform="rotate(-90 72 72)"/>
		<circle cx="${markerX.toFixed(2)}" cy="${markerY.toFixed(2)}" r="3.5" fill="${display.accent}"/>
		<text x="72" y="43" text-anchor="middle" fill="${COLORS.muted}"
			font-family="DejaVu Sans Mono, monospace" font-size="11" font-weight="700" letter-spacing="1.8">${display.label}</text>
		<text x="72" y="88" text-anchor="middle" fill="${COLORS.paper}"
			font-family="DejaVu Sans, sans-serif" font-size="${countSize}" font-weight="800" letter-spacing="-2">${escapeXml(display.count)}</text>
			<text x="72" y="111" text-anchor="middle" fill="${display.footerAccent ?? display.accent}"
			font-family="DejaVu Sans Condensed, sans-serif" font-size="${footerSize}" font-weight="800" letter-spacing="${footerSpacing}">${escapeXml(display.footer)}</text>
	`);
}

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
