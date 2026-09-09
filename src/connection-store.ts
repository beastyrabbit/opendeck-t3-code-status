import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LiveConnectionError, MAX_ENVIRONMENTS, originFrom, record, textValue } from "./t3-protocol.js";

export interface SavedConnection {
	environmentId: string;
	label: string;
	origin: string;
	token: string;
	expiresAt: number;
	allowHttp: boolean;
}
export interface ConnectionStore {
	load(): Promise<SavedConnection[]>;
	save(connections: SavedConnection[]): Promise<void>;
}

// Separate from profiles and installation files so exports/upgrades never carry credentials.
export class FileConnectionStore implements ConnectionStore {
	constructor(
		private readonly path = join(homedir(), ".config", "opendeck-t3-code-status", "connections.json"),
	) {}
	async load(): Promise<SavedConnection[]> {
		try {
			const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const stat = await handle.stat();
				if (
					!stat.isFile() ||
					stat.size > 256 * 1024 ||
					(process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
				)
					throw new Error();
				const buffer = Buffer.alloc(256 * 1024 + 1);
				let bytes = 0;
				while (bytes < buffer.length) {
					const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
					if (result.bytesRead === 0) break;
					bytes += result.bytesRead;
				}
				if (bytes > 256 * 1024) throw new Error();
				const value: unknown = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
				if (!Array.isArray(value) || value.length > MAX_ENVIRONMENTS) throw new Error();
				const ids = new Set<string>();
				return value.map((item) => {
					if (
						!record(item) ||
						!textValue(item.environmentId) ||
						ids.has(item.environmentId) ||
						!textValue(item.label, 120) ||
						!textValue(item.origin, 2048) ||
						!textValue(item.token, 8192) ||
						typeof item.expiresAt !== "number" ||
						!Number.isFinite(item.expiresAt) ||
						typeof item.allowHttp !== "boolean" ||
						originFrom(item.origin, item.allowHttp) !== item.origin
					)
						throw new Error();
					ids.add(item.environmentId);
					return item as unknown as SavedConnection;
				});
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (record(error) && error.code === "ENOENT") return [];
			throw new LiveConnectionError("storage-error");
		}
	}
	async save(connections: SavedConnection[]): Promise<void> {
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			const folder = dirname(this.path);
			await mkdir(folder, { recursive: true, mode: 0o700 });
			const stat = await lstat(folder);
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				(process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
			)
				throw new Error();
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(connections));
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.path);
		} catch {
			throw new LiveConnectionError("storage-error");
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}
}
