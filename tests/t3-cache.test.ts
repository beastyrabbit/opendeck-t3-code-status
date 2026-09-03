import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { serialize } from "node:v8";

import {
	collectCachedT3Shells,
	crc32c,
	createT3CacheAllocationBudget,
	databaseFilenames,
	decodeIndexedDbStringKey,
	decodeStoredShellValue,
	discoverT3CacheDirectories,
	type LevelDbRecord,
	maskLevelDbCrc32c,
	parseIndexedDbKeyPrefix,
	parseLevelDbLog,
	parseLevelDbTable,
	readT3ShellCache,
	sameFileIdentity,
	T3CacheError,
} from "../src/t3-cache.js";

interface SnappyApi {
	compress(input: Uint8Array): Uint8Array;
}

const require = createRequire(import.meta.url);
const snappy = require("snappyjs") as SnappyApi;
const TABLE_MAGIC = Buffer.from("57fb808b247547db", "hex");
const CRC32C_POLYNOMIAL = 0x82f63b78;
const CRC32C_MASK_DELTA = 0xa282ead8;
const MAX_STORED_SHELL_PAYLOAD_BYTES = 8 * 1024 * 1024;
const WRAPPER_BLOB_MIME_TYPE = "application/vnd.blink-idb-value-wrapper";
const run = promisify(execFile);

function fixtureCrc32c(buffer: Uint8Array): number {
	let checksum = 0xffffffff;
	for (const byte of buffer) {
		checksum ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			checksum = (checksum >>> 1) ^ ((checksum & 1) === 1 ? CRC32C_POLYNOMIAL : 0);
		}
	}
	return (checksum ^ 0xffffffff) >>> 0;
}

function fixtureMaskedCrc32c(buffer: Uint8Array): number {
	const checksum = fixtureCrc32c(buffer);
	return (((checksum >>> 15) | (checksum << 17)) + CRC32C_MASK_DELTA) >>> 0;
}

function encodeVarint(input: number): Buffer {
	let value = input;
	const bytes: number[] = [];
	do {
		let byte = value % 128;
		value = Math.floor(value / 128);
		if (value > 0) byte |= 0x80;
		bytes.push(byte);
	} while (value > 0);
	return Buffer.from(bytes);
}

function encodeBigVarint(input: bigint): Buffer {
	let value = input;
	const bytes: number[] = [];
	do {
		let byte = Number(value & 0x7fn);
		value >>= 7n;
		if (value > 0n) byte |= 0x80;
		bytes.push(byte);
	} while (value > 0n);
	return Buffer.from(bytes);
}

function indexedDbStringKey(environmentId: string, objectStoreId = 2, indexId = 1): Buffer {
	const encoded = Buffer.alloc(environmentId.length * 2);
	for (let index = 0; index < environmentId.length; index += 1) {
		encoded.writeUInt16BE(environmentId.charCodeAt(index), index * 2);
	}
	return Buffer.concat([
		Buffer.from([0, 1, objectStoreId, indexId, 1]),
		encodeVarint(environmentId.length),
		encoded,
	]);
}

function shellSnapshot(
	environmentId: string,
	sequence: number,
	compressed = true,
	threads: readonly unknown[] = [],
	updatedAt = "2030-01-01T00:00:00.000Z",
): Buffer {
	return storedString(shellJson(environmentId, sequence, threads, updatedAt), compressed);
}

function shellJson(
	environmentId: string,
	sequence: number,
	threads: readonly unknown[],
	updatedAt: string,
): string {
	return JSON.stringify({
		environmentId,
		schemaVersion: 1,
		snapshot: {
			snapshotSequence: sequence,
			threads,
			updatedAt,
		},
	});
}

function storedString(value: string, compressed = false): Buffer {
	return storedSerialized(serialize(value), compressed);
}

function storedSerialized(serialized: Uint8Array, compressed = false): Buffer {
	return Buffer.concat([encodeVarint(42), blinkWireData(serialized, compressed)]);
}

function blinkWireData(serialized: Uint8Array, compressed = false): Buffer {
	const blinkEnvelope = Buffer.concat([Buffer.from([0xff, 21, 0xfe]), Buffer.alloc(12), serialized]);
	return compressed
		? Buffer.concat([Buffer.from([0xff, 0x11, 0x02]), Buffer.from(snappy.compress(blinkEnvelope))])
		: blinkEnvelope;
}

function primitiveV8String(
	value: string,
	encoding: "latin1" | "utf16le" | "utf8",
	paddingBytes?: number,
	globalOffset = 15,
	version = 15,
): Buffer {
	const tags = { latin1: 0x22, utf16le: 0x63, utf8: 0x53 } as const;
	const encoded = Buffer.from(value, encoding);
	const encodedLength = encodeVarint(encoded.length);
	const canonicalPadding =
		encoding === "utf16le" && (globalOffset + 3 + encodedLength.length) % 2 !== 0 ? 1 : 0;
	return Buffer.concat([
		Buffer.concat([Buffer.from([0xff]), encodeVarint(version)]),
		Buffer.alloc(paddingBytes ?? canonicalPadding),
		Buffer.from([tags[encoding]]),
		encodedLength,
		encoded,
	]);
}

function levelDbRecord(
	environmentId: string,
	sequence: number,
	value: Buffer,
	options: { indexId?: number; objectStoreId?: number; recordType?: 0 | 1 } = {},
): LevelDbRecord {
	return {
		key: indexedDbStringKey(environmentId, options.objectStoreId, options.indexId),
		offset: 0,
		recordType: options.recordType ?? 1,
		sequence: BigInt(sequence),
		value,
	};
}

function externalShellMarker(blobSize: number, blobIndex = 0): Buffer {
	return Buffer.concat([
		encodeVarint(42),
		Buffer.from([0xff, 0x11, 0x01]),
		encodeVarint(blobSize),
		encodeVarint(blobIndex),
	]);
}

function metadataString(value: string): Buffer {
	const encoded = Buffer.alloc(value.length * 2);
	for (let index = 0; index < value.length; index += 1) {
		encoded.writeUInt16BE(value.charCodeAt(index), index * 2);
	}
	return Buffer.concat([encodeBigVarint(BigInt(value.length)), encoded]);
}

function blobMetadata(blobNumber: bigint, size: bigint, mimeType = WRAPPER_BLOB_MIME_TYPE): Buffer {
	return Buffer.concat([
		Buffer.from([0]),
		encodeBigVarint(blobNumber),
		metadataString(mimeType),
		encodeBigVarint(size),
	]);
}

function fileMetadata(blobNumber: bigint, size: bigint, lastModified = 1_900_000_000_000_000n): Buffer {
	return Buffer.concat([
		Buffer.from([1]),
		encodeBigVarint(blobNumber),
		metadataString("text/plain"),
		encodeBigVarint(size),
		metadataString("fixture.txt"),
		encodeBigVarint(lastModified),
	]);
}

function fileSystemAccessMetadata(token = Buffer.from([1, 2, 3])): Buffer {
	return Buffer.concat([Buffer.from([2]), encodeBigVarint(BigInt(token.length)), token]);
}

interface WriteOperation {
	key: Buffer;
	type: 0 | 1;
	value?: Buffer;
}

function fakeDirectory(
	names: readonly string[],
	options: { directories?: boolean } = {},
): {
	open: () => Promise<{
		read: () => Promise<{
			name: string;
			isDirectory: () => boolean;
			isSymbolicLink: () => boolean;
		} | null>;
		close: () => Promise<void>;
	}>;
	state: { closes: number; reads: number };
} {
	const state = { closes: 0, reads: 0 };
	return {
		open: async () => ({
			read: async () => {
				const index = state.reads;
				state.reads += 1;
				const name = names[index];
				if (name === undefined) return null;
				return {
					name,
					isDirectory: () => options.directories === true,
					isSymbolicLink: () => false,
				};
			},
			close: async () => {
				state.closes += 1;
			},
		}),
		state,
	};
}

function writeBatch(firstSequence: bigint, operations: readonly WriteOperation[]): Buffer {
	const header = Buffer.alloc(12);
	header.writeBigUInt64LE(firstSequence, 0);
	header.writeUInt32LE(operations.length, 8);
	const entries = operations.map((operation) =>
		Buffer.concat([
			Buffer.from([operation.type]),
			encodeVarint(operation.key.length),
			operation.key,
			...(operation.type === 1
				? [encodeVarint(operation.value?.length ?? 0), operation.value ?? Buffer.alloc(0)]
				: []),
		]),
	);
	return Buffer.concat([header, ...entries]);
}

function physicalLogRecord(type: 1 | 2 | 3 | 4, contents: Buffer): Buffer {
	const header = Buffer.alloc(7);
	header.writeUInt32LE(fixtureMaskedCrc32c(Buffer.concat([Buffer.from([type]), contents])), 0);
	header.writeUInt16LE(contents.length, 4);
	header[6] = type;
	return Buffer.concat([header, contents]);
}

function logFile(firstSequence: bigint, operations: readonly WriteOperation[]): Buffer {
	return physicalLogRecord(1, writeBatch(firstSequence, operations));
}

function internalKey(record: LevelDbRecord): Buffer {
	const trailer = Buffer.alloc(8);
	trailer.writeBigUInt64LE((record.sequence << 8n) | BigInt(record.recordType));
	return Buffer.concat([record.key, trailer]);
}

function tableBlock(entries: ReadonlyArray<{ key: Buffer; value: Buffer }>): Buffer {
	const encoded: Buffer[] = [];
	for (const entry of entries) {
		encoded.push(
			encodeVarint(0),
			encodeVarint(entry.key.length),
			encodeVarint(entry.value.length),
			entry.key,
			entry.value,
		);
	}
	const restarts = Buffer.alloc(8);
	restarts.writeUInt32LE(0, 0);
	restarts.writeUInt32LE(1, 4);
	return Buffer.concat([...encoded, restarts]);
}

function blockWithTrailer(raw: Buffer, compression: 0 | 1): { bytes: Buffer; size: number } {
	const contents = compression === 1 ? Buffer.from(snappy.compress(raw)) : raw;
	const trailer = Buffer.alloc(5);
	trailer[0] = compression;
	trailer.writeUInt32LE(fixtureMaskedCrc32c(Buffer.concat([contents, Buffer.from([compression])])), 1);
	return {
		bytes: Buffer.concat([contents, trailer]),
		size: contents.length,
	};
}

function tableFile(records: readonly LevelDbRecord[], compression: 0 | 1): Buffer {
	const data = blockWithTrailer(
		tableBlock(records.map((record) => ({ key: internalKey(record), value: record.value }))),
		compression,
	);
	const indexKey = Buffer.alloc(9);
	indexKey[8] = 1;
	const dataHandle = Buffer.concat([encodeVarint(0), encodeVarint(data.size)]);
	const metaindex = blockWithTrailer(tableBlock([]), 0);
	const metaindexOffset = data.bytes.length;
	const index = blockWithTrailer(tableBlock([{ key: indexKey, value: dataHandle }]), 0);
	const indexOffset = metaindexOffset + metaindex.bytes.length;
	const footerHandles = Buffer.concat([
		encodeVarint(metaindexOffset),
		encodeVarint(metaindex.size),
		encodeVarint(indexOffset),
		encodeVarint(index.size),
	]);
	const footer = Buffer.alloc(40);
	footerHandles.copy(footer);
	return Buffer.concat([data.bytes, metaindex.bytes, index.bytes, footer, TABLE_MAGIC]);
}

function tableFileWithDuplicateDataHandle(record: LevelDbRecord): Buffer {
	const data = blockWithTrailer(tableBlock([{ key: internalKey(record), value: record.value }]), 1);
	const dataHandle = Buffer.concat([encodeVarint(0), encodeVarint(data.size)]);
	const metaindex = blockWithTrailer(tableBlock([]), 0);
	const metaindexOffset = data.bytes.length;
	const index = blockWithTrailer(
		tableBlock([
			{ key: Buffer.from("index-a"), value: dataHandle },
			{ key: Buffer.from("index-b"), value: dataHandle },
		]),
		0,
	);
	const indexOffset = metaindexOffset + metaindex.bytes.length;
	const footerHandles = Buffer.concat([
		encodeVarint(metaindexOffset),
		encodeVarint(metaindex.size),
		encodeVarint(indexOffset),
		encodeVarint(index.size),
	]);
	const footer = Buffer.alloc(40);
	footerHandles.copy(footer);
	return Buffer.concat([data.bytes, metaindex.bytes, index.bytes, footer, TABLE_MAGIC]);
}

function validThread(id = "thread-a"): Record<string, unknown> {
	return {
		id,
		interactionMode: "default",
		archivedAt: null,
		settledOverride: null,
		settledAt: null,
		latestUserMessageAt: "2030-01-01T00:00:00.000Z",
		snoozedAt: null,
		snoozedUntil: null,
		hasPendingApprovals: false,
		hasPendingUserInput: false,
		hasActionableProposedPlan: false,
		backgroundLiveness: "working",
		latestTurn: {
			state: "running",
			requestedAt: "2030-01-01T00:00:00.000Z",
			startedAt: "2030-01-01T00:00:01.000Z",
			completedAt: null,
			extraLatestTurnField: { preserved: true },
		},
		session: {
			status: "running",
			updatedAt: "2030-01-01T00:00:02.000Z",
			extraSessionField: 42,
		},
		extraThreadField: ["preserved"],
	};
}

function assertCorrupt(callback: () => unknown): void {
	assert.throws(callback, (error: unknown) => error instanceof T3CacheError && error.code === "corrupt");
}

function assertUnsupported(callback: () => unknown): void {
	assert.throws(callback, (error: unknown) => error instanceof T3CacheError && error.code === "unsupported");
}

async function cacheDirectory(context: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opendeck-t3-cache-test-"));
	context.after(async () => {
		await rm(directory, { force: true, recursive: true });
	});
	return directory;
}

type MetadataState = "live" | "missing" | "stale" | "tombstoned";

async function writeExternalShellCache(
	context: TestContext,
	options: {
		blobContents?: Buffer;
		blobIndex?: number;
		blobNumber?: number;
		compressed?: boolean;
		dataValue?: Buffer;
		environmentId?: string;
		markerSize?: number;
		metadataEnvironmentId?: string;
		metadataState?: MetadataState;
		metadataValue?: Buffer;
		unrelatedOperations?: readonly WriteOperation[];
		writeBlob?: boolean;
	} = {},
): Promise<{ blobPath: string; directory: string; wireData: Buffer }> {
	const root = await cacheDirectory(context);
	const directory = join(root, "t3code_app_0.indexeddb.leveldb");
	const environmentId = options.environmentId ?? "environment-€";
	const serialized = primitiveV8String(
		shellJson(environmentId, 7, [], "2030-01-01T00:00:00.000Z"),
		"utf16le",
	);
	const wireData = blinkWireData(serialized, options.compressed);
	const markerSize = options.markerSize ?? wireData.length;
	const blobIndex = options.blobIndex ?? 0;
	const blobNumber = options.blobNumber ?? 0x1234;
	const metadataValue = options.metadataValue ?? blobMetadata(BigInt(blobNumber), BigInt(markerSize));
	const data: WriteOperation = {
		key: indexedDbStringKey(environmentId),
		type: 1,
		value: options.dataValue ?? externalShellMarker(markerSize, blobIndex),
	};
	const metadata: WriteOperation = {
		key: indexedDbStringKey(options.metadataEnvironmentId ?? environmentId, 2, 3),
		type: 1,
		value: metadataValue,
	};
	let operations: WriteOperation[];
	if (options.metadataState === "missing") operations = [data];
	else if (options.metadataState === "stale") operations = [metadata, data];
	else if (options.metadataState === "tombstoned") {
		operations = [data, metadata, { key: metadata.key, type: 0 }];
	} else operations = [data, metadata];
	operations.push(...(options.unrelatedOperations ?? []));

	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "000001.log"), logFile(20n, operations));
	const blobPath = join(
		root,
		"t3code_app_0.indexeddb.blob",
		"1",
		(Math.floor(blobNumber / 256) % 256).toString(16).padStart(2, "0"),
		blobNumber.toString(16),
	);
	if (options.writeBlob !== false) {
		await mkdir(join(blobPath, ".."), { recursive: true });
		await writeFile(blobPath, options.blobContents ?? wireData);
	}
	return { blobPath, directory, wireData };
}

async function assertCacheError(
	promise: Promise<unknown>,
	code: "corrupt" | "inconsistent" | "unsupported",
): Promise<void> {
	await assert.rejects(promise, (error: unknown) => error instanceof T3CacheError && error.code === code);
}

async function writeProfileCache(
	configDirectory: string,
	profileName: string,
	records: ReadonlyArray<{
		environmentId: string;
		sequence: number;
		updatedAt: string;
	}>,
): Promise<string> {
	const directory = join(configDirectory, profileName, "IndexedDB", "t3code_app_0.indexeddb.leveldb");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "000001.log"),
		logFile(
			1n,
			records.map(({ environmentId, sequence, updatedAt }) => ({
				key: indexedDbStringKey(environmentId),
				type: 1,
				value: shellSnapshot(
					environmentId,
					sequence,
					true,
					[validThread(`${profileName}-${environmentId}`)],
					updatedAt,
				),
			})),
		),
	);
	return directory;
}

describe("Chromium IndexedDB primitives", () => {
	test("computes and masks the standard CRC32C test vector", () => {
		const vector = Buffer.from("123456789");
		assert.equal(crc32c(vector), 0xe3069283);
		assert.equal(maskLevelDbCrc32c(crc32c(vector)), 0xc78ab0e5);
	});

	test("decodes the exact T3 shell-store key prefix and environment key", () => {
		const key = indexedDbStringKey("environment-a");
		assert.deepEqual(parseIndexedDbKeyPrefix(key), {
			bytesRead: 4,
			databaseId: 1,
			indexId: 1,
			objectStoreId: 2,
		});
		assert.equal(decodeIndexedDbStringKey(key), "environment-a");
	});

	test("rejects oversized environment keys before allocating their code units", () => {
		assertUnsupported(() => decodeIndexedDbStringKey(indexedDbStringKey("x".repeat(1_025))));
		assertUnsupported(() =>
			collectCachedT3Shells([levelDbRecord("x".repeat(1_025), 1, shellSnapshot("environment-a", 1))]),
		);
	});

	test("rejects trailing bytes in an environment key", () => {
		assertCorrupt(() =>
			decodeIndexedDbStringKey(Buffer.concat([indexedDbStringKey("environment-a"), Buffer.from([0])])),
		);
	});

	test("decodes every primitive V8 string encoding with canonical alignment", () => {
		for (const version of [15, 16]) {
			for (const compressed of [false, true]) {
				for (const [environmentId, encoding] of [
					["environment-ä", "latin1"],
					["environment-€", "utf16le"],
					["environment-€", "utf8"],
				] as const) {
					const stored = decodeStoredShellValue(
						storedSerialized(
							primitiveV8String(
								shellJson(environmentId, 7, [], "2030-01-01T00:00:00.000Z"),
								encoding,
								undefined,
								15,
								version,
							),
							compressed,
						),
					);
					assert.equal(stored.environmentId, environmentId);
					assert.equal(stored.snapshot.snapshotSequence, 7);
				}
			}
		}
	});

	test("rejects every non-string V8 value without constructing its object graph", () => {
		for (const serialized of [
			serialize({ environmentId: "environment-a" }),
			serialize([]),
			Buffer.from("ff0f618087a70e40008087a70e", "hex"),
		]) {
			assertCorrupt(() => decodeStoredShellValue(storedSerialized(serialized)));
		}
	});

	test("rejects trailing bytes and malformed primitive V8 strings", () => {
		const validJson = shellJson("environment-a", 7, [], "2030-01-01T00:00:00.000Z");
		for (const serialized of [
			Buffer.concat([primitiveV8String(validJson, "latin1"), Buffer.from([0])]),
			Buffer.from([0xff, 0x80, 0x00, 0x22, 0x00]),
			Buffer.from([0xff, 0x80, 0x80, 0x80, 0x80, 0x10, 0x22, 0x00]),
			Buffer.from([0xff, 0x0f, 0x22, 0x80, 0x00]),
			Buffer.from([0xff, 0x0f, 0x63, 0x01, 0x00]),
			Buffer.from([0xff, 0x0f, 0x53, 0x02, 0xc3, 0x28]),
			primitiveV8String(`\uFEFF${validJson}`, "utf8"),
			primitiveV8String(validJson, "latin1", 1),
			primitiveV8String(validJson, "utf16le", 1),
			primitiveV8String(validJson, "utf16le", 2),
		]) {
			assertCorrupt(() => decodeStoredShellValue(storedSerialized(serialized)));
		}
	});

	test("aligns two-byte strings against the complete Blink wire payload", () => {
		const validJson = shellJson("environment-€", 7, [], "2030-01-01T00:00:00.000Z");
		const blinkAligned = primitiveV8String(validJson, "utf16le", undefined, 15);
		assert.equal(decodeStoredShellValue(storedSerialized(blinkAligned)).environmentId, "environment-€");

		const standaloneAligned = primitiveV8String(validJson, "utf16le", undefined, 0);
		assertCorrupt(() => decodeStoredShellValue(storedSerialized(standaloneAligned)));

		const threeByteLengthJson = `${validJson.slice(0, -1)},"padding":"${"x".repeat(9_000)}"}`;
		const threeByteBlinkAligned = primitiveV8String(threeByteLengthJson, "utf16le", undefined, 15);
		assert.deepEqual([...threeByteBlinkAligned.subarray(0, 4)], [0xff, 0x0f, 0, 0x63]);
		assert.equal((threeByteBlinkAligned[4] ?? 0) & 0x80, 0x80);
		assert.equal((threeByteBlinkAligned[5] ?? 0) & 0x80, 0x80);
		assert.equal((threeByteBlinkAligned[6] ?? 0) & 0x80, 0);
		assert.equal(
			decodeStoredShellValue(storedSerialized(threeByteBlinkAligned)).environmentId,
			"environment-€",
		);
		assertCorrupt(() =>
			decodeStoredShellValue(
				storedSerialized(primitiveV8String(threeByteLengthJson, "utf16le", undefined, 0)),
			),
		);
	});

	test("rejects V8 string format versions outside the two observed T3 formats", () => {
		const validJson = shellJson("environment-a", 7, [], "2030-01-01T00:00:00.000Z");
		for (const version of [0, 14, 17, 128]) {
			assertUnsupported(() =>
				decodeStoredShellValue(
					storedSerialized(primitiveV8String(validJson, "latin1", undefined, 15, version)),
				),
			);
		}
	});

	test("filters every non-shell store before decoding any value", () => {
		const invalidSecretStoreValue = Buffer.from("not a V8 value");
		const records = [
			levelDbRecord("credential-like-key", 10, invalidSecretStoreValue, { objectStoreId: 1 }),
			levelDbRecord("thread-key", 11, invalidSecretStoreValue, { objectStoreId: 3 }),
			levelDbRecord("blob-metadata", 12, invalidSecretStoreValue, { indexId: 3 }),
			levelDbRecord("environment-a", 13, shellSnapshot("environment-a", 13)),
		];
		assert.deepEqual(
			collectCachedT3Shells(records).map(({ environmentId }) => environmentId),
			["environment-a"],
		);
	});

	test("accepts complete thread shells and preserves unknown T3 fields", () => {
		const stored = decodeStoredShellValue(shellSnapshot("environment-a", 7, true, [validThread()]));
		const thread = stored.snapshot.threads[0] as unknown as Record<string, unknown>;
		assert.deepEqual(thread.extraThreadField, ["preserved"]);
		assert.deepEqual((thread.latestTurn as Record<string, unknown>).extraLatestTurnField, {
			preserved: true,
		});
		assert.equal((thread.session as Record<string, unknown>).extraSessionField, 42);
	});

	test("rejects malformed fields consumed by thread status classification", () => {
		const withoutArchivedAt = validThread();
		delete withoutArchivedAt.archivedAt;
		const wrongBoolean = validThread();
		wrongBoolean.hasPendingApprovals = "false";
		const malformedSession = validThread();
		malformedSession.session = { status: "running", updatedAt: "not-a-timestamp" };
		const invalidTimestamp = validThread();
		invalidTimestamp.latestUserMessageAt = "not-a-timestamp";
		const unknownLiveness = validThread();
		unknownLiveness.backgroundLiveness = "sleeping";
		const unknownTurnState = validThread();
		unknownTurnState.latestTurn = { state: "future-state" };

		for (const [label, threads] of [
			["missing archivedAt", [withoutArchivedAt]],
			["non-boolean pending flag", [wrongBoolean]],
			["malformed session", [malformedSession]],
			["invalid timestamp", [invalidTimestamp]],
			["unknown background liveness", [unknownLiveness]],
			["unknown latest-turn state", [unknownTurnState]],
			["duplicate thread IDs", [validThread(), validThread()]],
		] as const) {
			assertCorrupt(() => decodeStoredShellValue(shellSnapshot("environment-a", 7, true, threads)));
			assert.ok(label);
		}
	});

	test("accepts an unknown non-empty session status conservatively", () => {
		const future = validThread();
		future.session = { status: "future-status", updatedAt: "2030-01-01T00:00:02.000Z" };
		const stored = decodeStoredShellValue(shellSnapshot("environment-a", 7, true, [future]));
		assert.equal(stored.snapshot.threads[0]?.session?.status, "future-status");
	});

	test("enforces a shared allocation budget while decoding compressed values", () => {
		assert.throws(
			() =>
				decodeStoredShellValue(
					shellSnapshot("environment-a", 7, true, [validThread()]),
					createT3CacheAllocationBudget(1),
				),
			(error: unknown) => error instanceof T3CacheError && error.code === "unsupported",
		);
	});

	test("bounds serialized shell values before decoding", () => {
		assertUnsupported(() => decodeStoredShellValue(storedString("x".repeat(8 * 1024 * 1024 + 1))));
	});

	test("accepts the serialized shell boundary and rejects the next byte", () => {
		const base = shellJson("environment-a", 7, [], "2030-01-01T00:00:00.000Z");
		const property = ',"padding":""';
		const withProperty = `${base.slice(0, -1)}${property}}`;
		// At this size the V8 header, tag, and uint32 varint occupy seven bytes.
		const targetJsonBytes = MAX_STORED_SHELL_PAYLOAD_BYTES - 7;
		const json = `${withProperty.slice(0, -2)}${"x".repeat(targetJsonBytes - withProperty.length)}"}`;
		const serialized = primitiveV8String(json, "latin1");
		assert.equal(serialized.length, MAX_STORED_SHELL_PAYLOAD_BYTES);
		assert.equal(
			decodeStoredShellValue(storedSerialized(serialized), createT3CacheAllocationBudget(512 * 1024 * 1024))
				.environmentId,
			"environment-a",
		);
		assertUnsupported(() =>
			decodeStoredShellValue(
				storedSerialized(Buffer.concat([serialized, Buffer.from([0])])),
				createT3CacheAllocationBudget(512 * 1024 * 1024),
			),
		);
	});

	test("reserves a conservative JSON parser amplification estimate", () => {
		const json = shellJson("environment-a", 7, [validThread()], "2030-01-01T00:00:00.000Z");
		const raw = storedString(json);
		const serializedBytes = raw.length - encodeVarint(42).length - 15;
		const decodedAllocationBytes = serializedBytes * 2;
		const estimatedBytes = Buffer.byteLength(json) * 32;
		assertUnsupported(() =>
			decodeStoredShellValue(raw, createT3CacheAllocationBudget(decodedAllocationBytes + estimatedBytes - 1)),
		);
		const exactBudget = createT3CacheAllocationBudget(decodedAllocationBytes + estimatedBytes);
		assert.equal(decodeStoredShellValue(raw, exactBudget).environmentId, "environment-a");
		assert.equal(exactBudget.remainingBytes, 0);
	});
});

describe("LevelDB readers", () => {
	test("parses WAL batches and preserves the newest tombstone", () => {
		const key = indexedDbStringKey("environment-a");
		const parsed = parseLevelDbLog(
			logFile(20n, [
				{ key, type: 1, value: shellSnapshot("environment-a", 1) },
				{ key, type: 0 },
			]),
		);
		assert.deepEqual(
			parsed.map(({ recordType, sequence }) => ({ recordType, sequence })),
			[
				{ recordType: 1, sequence: 20n },
				{ recordType: 0, sequence: 21n },
			],
		);
		assert.deepEqual(collectCachedT3Shells(parsed), []);
	});

	test("parses complete fragmented WAL batches", () => {
		const batch = writeBatch(20n, [
			{
				key: indexedDbStringKey("environment-a"),
				type: 1,
				value: shellSnapshot("environment-a", 1),
			},
		]);
		const firstEnd = Math.floor(batch.length / 3);
		const middleEnd = Math.floor((batch.length * 2) / 3);
		const parsed = parseLevelDbLog(
			Buffer.concat([
				physicalLogRecord(2, batch.subarray(0, firstEnd)),
				physicalLogRecord(3, batch.subarray(firstEnd, middleEnd)),
				physicalLogRecord(4, batch.subarray(middleEnd)),
			]),
		);

		assert.equal(parsed.length, 1);
		assert.equal(parsed[0]?.sequence, 20n);
	});

	test("rejects trailing operations omitted from a WAL batch count", () => {
		const batch = writeBatch(20n, [
			{ key: Buffer.from("a"), type: 0 },
			{ key: Buffer.from("b"), type: 0 },
		]);
		batch.writeUInt32LE(1, 8);
		assertCorrupt(() => parseLevelDbLog(physicalLogRecord(1, batch)));
	});

	test("rejects complete orphaned WAL fragments but ignores a final unfinished batch", () => {
		const contents = Buffer.from("complete physical fragment");
		for (const type of [3, 4] as const) {
			assertCorrupt(() => parseLevelDbLog(physicalLogRecord(type, contents)));
		}
		assert.deepEqual(parseLevelDbLog(physicalLogRecord(2, contents)), []);
		assertCorrupt(() =>
			parseLevelDbLog(Buffer.concat([physicalLogRecord(2, contents), physicalLogRecord(1, contents)])),
		);
	});

	test("parses uncompressed and Snappy-compressed SST data blocks", () => {
		for (const compression of [0, 1] as const) {
			const source = levelDbRecord(
				`environment-${compression}`,
				30 + compression,
				shellSnapshot(`environment-${compression}`, compression),
			);
			const parsed = parseLevelDbTable(tableFile([source], compression));
			assert.equal(parsed.length, 1);
			assert.equal(parsed[0]?.sequence, source.sequence);
			assert.deepEqual(collectCachedT3Shells(parsed), [
				{
					environmentId: `environment-${compression}`,
					snapshot: decodeStoredShellValue(source.value).snapshot,
				},
			]);
		}
	});

	test("rejects duplicate table block handles", () => {
		const source = levelDbRecord("environment-a", 30, shellSnapshot("environment-a", 1));
		assertCorrupt(() => parseLevelDbTable(tableFileWithDuplicateDataHandle(source)));
	});

	test("bounds the number of physical and logical log records", () => {
		const cacheLog = logFile(20n, [
			{ key: indexedDbStringKey("environment-a"), type: 1, value: shellSnapshot("environment-a", 1) },
		]);
		assert.throws(
			() => parseLevelDbLog(cacheLog, undefined, createT3CacheAllocationBudget(1024 * 1024, 1)),
			(error: unknown) => error instanceof T3CacheError && error.code === "unsupported",
		);
	});

	test("reserves the WAL key and value budget before copying either", () => {
		const key = indexedDbStringKey("environment-a");
		const value = shellSnapshot("environment-a", 1);
		const log = logFile(20n, [{ key, type: 1, value }]);
		const allocationBytes = key.length + value.length;
		assertUnsupported(() =>
			parseLevelDbLog(log, undefined, createT3CacheAllocationBudget(allocationBytes - 1)),
		);
		const exactBudget = createT3CacheAllocationBudget(allocationBytes);
		assert.equal(parseLevelDbLog(log, undefined, exactBudget).length, 1);
		assert.equal(exactBudget.remainingBytes, 0);
	});

	test("rejects a checksum mismatch in a complete WAL physical record", () => {
		const corrupted = Buffer.from(
			logFile(20n, [
				{ key: indexedDbStringKey("environment-a"), type: 1, value: shellSnapshot("environment-a", 1) },
			]),
		);
		const corruptedByte = corrupted.length - 1;
		corrupted.writeUInt8(corrupted.readUInt8(corruptedByte) ^ 0x01, corruptedByte);
		assertCorrupt(() => parseLevelDbLog(corrupted));
	});

	test("rejects a checksum mismatch in an SST data block", () => {
		const source = levelDbRecord("environment-a", 30, shellSnapshot("environment-a", 1));
		const corrupted = Buffer.from(tableFile([source], 0));
		corrupted.writeUInt8(corrupted.readUInt8(0) ^ 0x01, 0);
		assertCorrupt(() => parseLevelDbTable(corrupted));
	});

	test("ignores an incomplete final WAL append tail", () => {
		const complete = logFile(20n, [
			{ key: indexedDbStringKey("environment-a"), type: 1, value: shellSnapshot("environment-a", 1) },
		]);
		const incompleteHeader = Buffer.alloc(7);
		incompleteHeader.writeUInt16LE(10, 4);
		incompleteHeader[6] = 1;
		const parsed = parseLevelDbLog(Buffer.concat([complete, incompleteHeader, Buffer.from([1, 2])]));
		assert.equal(parsed.length, 1);
	});
});

describe("stable file identity", () => {
	test("accepts Windows lstat and fstat identities when Node reports different devices", () => {
		assert.equal(sameFileIdentity({ dev: 2n, ino: 42n }, { dev: 0n, ino: 42n }, "win32"), true);
	});

	test("rejects changed and unavailable Windows file IDs", () => {
		assert.equal(sameFileIdentity({ dev: 2n, ino: 42n }, { dev: 0n, ino: 43n }, "win32"), false);
		assert.equal(sameFileIdentity({ dev: 2n, ino: 0n }, { dev: 0n, ino: 0n }, "win32"), false);
	});

	test("requires matching devices on Unix", () => {
		assert.equal(sameFileIdentity({ dev: 2n, ino: 42n }, { dev: 3n, ino: 42n }, "linux"), false);
		assert.equal(sameFileIdentity({ dev: 2n, ino: 42n }, { dev: 2n, ino: 42n }, "darwin"), true);
	});
});

test("rejects Blink trailers that extend beyond the stored value", () => {
	const serialized = serialize(shellJson("environment-a", 1, [], "2030-01-01T00:00:00.000Z"));
	const envelope = Buffer.concat([Buffer.from([0xff, 21, 0xfe]), Buffer.alloc(12), serialized]);
	envelope.writeBigUInt64BE(BigInt(envelope.length), 3);
	envelope.writeUInt32BE(1, 11);
	assertCorrupt(() => decodeStoredShellValue(Buffer.concat([encodeVarint(42), envelope])));
});

describe("external Chromium IndexedDB values", () => {
	for (const compressed of [false, true]) {
		test(`reads a ${compressed ? "Snappy-compressed" : "raw"} wrapper blob`, async (context) => {
			const { directory } = await writeExternalShellCache(context, {
				compressed,
				unrelatedOperations: [
					{
						key: indexedDbStringKey("not-a-shell", 3, 3),
						type: 1,
						value: Buffer.from("not external-object metadata"),
					},
					{
						key: indexedDbStringKey("not-object-store-data", 2, 2),
						type: 1,
						value: Buffer.from("not a serialized value"),
					},
				],
			});

			const shells = await readT3ShellCache({ directory });
			assert.equal(shells.length, 1);
			assert.equal(shells[0]?.environmentId, "environment-€");
			assert.equal(shells[0]?.snapshot.snapshotSequence, 7);
		});
	}

	test("derives the blob directory from bits 8 through 15 of the blob number", async (context) => {
		const { directory } = await writeExternalShellCache(context, { blobNumber: 0x12345 });
		assert.equal((await readT3ShellCache({ directory }))[0]?.environmentId, "environment-€");
	});

	test("counts Blob/File entries for blobIndex but permits later FSA metadata", async (context) => {
		const preliminaryFile = fileMetadata(2n, 5n);
		const precedingFsa = fileSystemAccessMetadata(Buffer.from([4, 5]));
		const placeholder = await writeExternalShellCache(context, { writeBlob: false });
		const metadataValue = Buffer.concat([
			preliminaryFile,
			precedingFsa,
			blobMetadata(0x1234n, BigInt(placeholder.wireData.length)),
			fileSystemAccessMetadata(Buffer.from([6, 7])),
		]);
		await rm(placeholder.directory, { recursive: true });
		const { directory } = await writeExternalShellCache(context, {
			blobIndex: 1,
			metadataValue,
		});

		assert.equal((await readT3ShellCache({ directory }))[0]?.environmentId, "environment-€");
	});

	for (const state of ["missing", "stale", "tombstoned"] as const) {
		test(`treats ${state} wrapper metadata as an inconsistent snapshot`, async (context) => {
			const { directory } = await writeExternalShellCache(context, { metadataState: state });
			await assertCacheError(readT3ShellCache({ directory }), "inconsistent");
		});
	}

	test("requires the metadata key to have the exact same encoded user-key suffix", async (context) => {
		const { directory } = await writeExternalShellCache(context, {
			metadataEnvironmentId: "another-environment",
		});
		await assertCacheError(readT3ShellCache({ directory }), "inconsistent");
	});

	test("treats a missing or size-changing blob file as inconsistent", async (context) => {
		const missing = await writeExternalShellCache(context, { writeBlob: false });
		await assertCacheError(readT3ShellCache({ directory: missing.directory }), "inconsistent");

		const wrongSize = await writeExternalShellCache(context, { blobContents: Buffer.from([1]) });
		await assertCacheError(readT3ShellCache({ directory: wrongSize.directory }), "inconsistent");
	});

	test("rejects a FIFO blob without blocking the cache read", {
		skip: process.platform !== "linux",
	}, async (context) => {
		const { blobPath, directory } = await writeExternalShellCache(context, { writeBlob: false });
		await mkdir(join(blobPath, ".."), { recursive: true });
		await run("mkfifo", [blobPath]);
		const readerUrl = new URL("../src/t3-cache.ts", import.meta.url).href;
		const script = `
			const { readT3ShellCache, T3CacheError } = await import(${JSON.stringify(readerUrl)});
			try {
				await readT3ShellCache({ directory: process.env.T3_TEST_CACHE_DIR });
				process.exitCode = 2;
			} catch (error) {
				if (!(error instanceof T3CacheError) || error.code !== "unsupported") process.exitCode = 3;
			}
		`;
		await run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
			env: { ...process.env, T3_TEST_CACHE_DIR: directory },
			timeout: 5_000,
		});
	});

	test("rejects malformed wrappers and metadata without opening a blob", async (context) => {
		const malformedWrapper = await writeExternalShellCache(context, {
			dataValue: Buffer.concat([externalShellMarker(1), Buffer.from([0])]),
		});
		await assertCacheError(readT3ShellCache({ directory: malformedWrapper.directory }), "corrupt");

		const wrongMime = await writeExternalShellCache(context, {
			metadataValue: blobMetadata(0x1234n, 1n, "application/octet-stream"),
			markerSize: 1,
		});
		await assertCacheError(readT3ShellCache({ directory: wrongMime.directory }), "corrupt");

		const truncatedMetadata = await writeExternalShellCache(context, {
			metadataValue: Buffer.from([0, 0x80]),
		});
		await assertCacheError(readT3ShellCache({ directory: truncatedMetadata.directory }), "corrupt");

		const aboveSignedInt64 = 1n << 63n;
		for (const metadataValue of [
			blobMetadata(aboveSignedInt64, 1n),
			blobMetadata(0x1234n, aboveSignedInt64),
			Buffer.concat([fileMetadata(2n, 1n, aboveSignedInt64), blobMetadata(0x1234n, 1n)]),
		]) {
			const outOfRangeMetadata = await writeExternalShellCache(context, {
				blobIndex: metadataValue[0] === 1 ? 1 : 0,
				markerSize: 1,
				metadataValue,
			});
			await assertCacheError(readT3ShellCache({ directory: outOfRangeMetadata.directory }), "corrupt");
		}
	});

	test("requires matching declared sizes and exactly one final wrapper Blob", async (context) => {
		const sizeMismatch = await writeExternalShellCache(context, {
			markerSize: 1,
			metadataValue: blobMetadata(0x1234n, 2n),
		});
		await assertCacheError(readT3ShellCache({ directory: sizeMismatch.directory }), "corrupt");

		const targetIsFile = await writeExternalShellCache(context, {
			blobIndex: 0,
			metadataValue: fileMetadata(0x1234n, 1n),
			markerSize: 1,
		});
		await assertCacheError(readT3ShellCache({ directory: targetIsFile.directory }), "corrupt");

		const duplicateWrapper = await writeExternalShellCache(context, { writeBlob: false });
		const duplicateMetadata = Buffer.concat([
			blobMetadata(2n, 1n),
			blobMetadata(0x1234n, BigInt(duplicateWrapper.wireData.length)),
		]);
		await rm(duplicateWrapper.directory, { recursive: true });
		const duplicate = await writeExternalShellCache(context, {
			blobIndex: 1,
			metadataValue: duplicateMetadata,
		});
		await assertCacheError(readT3ShellCache({ directory: duplicate.directory }), "corrupt");

		const wrapperBeforeAnotherBlob = await writeExternalShellCache(context, { writeBlob: false });
		const nonFinal = await writeExternalShellCache(context, {
			metadataValue: Buffer.concat([
				blobMetadata(0x1234n, BigInt(wrapperBeforeAnotherBlob.wireData.length)),
				blobMetadata(3n, 1n, "application/octet-stream"),
			]),
		});
		await assertCacheError(readT3ShellCache({ directory: nonFinal.directory }), "corrupt");
	});

	test("rejects oversized wrapper blobs before filesystem allocation", async (context) => {
		const { directory } = await writeExternalShellCache(context, {
			markerSize: MAX_STORED_SHELL_PAYLOAD_BYTES + 1,
			writeBlob: false,
		});
		await assertCacheError(readT3ShellCache({ directory }), "unsupported");
	});

	test("rejects corrupt wire data loaded from a correctly sized blob", async (context) => {
		const { directory } = await writeExternalShellCache(context, {
			blobContents: Buffer.from("not Blink wire data"),
			markerSize: Buffer.byteLength("not Blink wire data"),
		});
		await assertCacheError(readT3ShellCache({ directory }), "corrupt");

		const truncated = await writeExternalShellCache(context, {
			blobContents: Buffer.from([0xff]),
			markerSize: 1,
		});
		await assertCacheError(readT3ShellCache({ directory: truncated.directory }), "corrupt");
	});
});

test("readT3ShellCache merges SST and WAL records without interpreting other stores", async (context) => {
	const directory = await cacheDirectory(context);
	const oldEnvironmentA = levelDbRecord("environment-a", 4, shellSnapshot("environment-a", 1));
	await writeFile(join(directory, "000001.ldb"), tableFile([oldEnvironmentA], 1));
	await writeFile(
		join(directory, "000002.log"),
		logFile(5n, [
			{ key: indexedDbStringKey("credential-like-key", 1), type: 1, value: Buffer.from("private") },
			{ key: indexedDbStringKey("thread-key", 3), type: 1, value: Buffer.from("private") },
			{ key: indexedDbStringKey("environment-a"), type: 1, value: shellSnapshot("environment-a", 2) },
			{ key: indexedDbStringKey("environment-b"), type: 1, value: shellSnapshot("environment-b", 3) },
			{ key: indexedDbStringKey("environment-b"), type: 0 },
		]),
	);

	const cached = await readT3ShellCache({ directory });

	assert.equal(cached.length, 1);
	assert.equal(cached[0]?.environmentId, "environment-a");
	assert.equal(cached[0]?.snapshot.snapshotSequence, 2);
});

test("readT3ShellCache rejects an oversized database file without reading it", async (context) => {
	const directory = await cacheDirectory(context);
	const path = join(directory, "000001.log");
	await writeFile(path, "");
	await truncate(path, 64 * 1024 * 1024 + 1);

	await assert.rejects(
		readT3ShellCache({ directory }),
		(error: unknown) => error instanceof T3CacheError && error.code === "unsupported",
	);
});

test("database discovery stops after the fixed total-entry budget", async () => {
	const directory = fakeDirectory(Array.from({ length: 4_097 }, (_, index) => `ignored-${index}`));

	await assert.rejects(
		databaseFilenames("/untrusted-database", directory.open),
		(error: unknown) => error instanceof T3CacheError && error.code === "unsupported",
	);
	assert.deepEqual(directory.state, { closes: 1, reads: 4_097 });
});

test("database discovery filters and sorts a small directory", async () => {
	const directory = fakeDirectory(["000002.log", "LOCK", "000001.ldb"]);

	assert.deepEqual(await databaseFilenames("/small-database", directory.open), ["000001.ldb", "000002.log"]);
	assert.deepEqual(directory.state, { closes: 1, reads: 4 });
});

describe("T3 profile discovery", () => {
	test("finds current and legacy user-data caches without scanning unrelated directories", async (context) => {
		const configDirectory = await cacheDirectory(context);
		const expected = await Promise.all(
			["t3code", "T3 Code", "T3 Code (Alpha)", "T3 Code (Beta)"].map((profileName) =>
				writeProfileCache(configDirectory, profileName, [
					{
						environmentId: profileName,
						sequence: 1,
						updatedAt: "2030-01-01T00:00:00.000Z",
					},
				]),
			),
		);
		await writeProfileCache(configDirectory, "Some Other App", [
			{
				environmentId: "not-t3",
				sequence: 99,
				updatedAt: "2031-01-01T00:00:00.000Z",
			},
		]);

		assert.deepEqual(
			await discoverT3CacheDirectories({ configDirectory }),
			expected.sort((left, right) => left.localeCompare(right)),
		);
	});

	test("uses the bounded platform config roots on Linux, macOS, and Windows", async (context) => {
		const homeDirectory = await cacheDirectory(context);
		const cases: Array<{
			environment: Record<string, string>;
			platform: NodeJS.Platform;
			root: string;
		}> = [
			{
				environment: { XDG_CONFIG_HOME: join(homeDirectory, "xdg") },
				platform: "linux",
				root: join(homeDirectory, "xdg"),
			},
			{
				environment: {},
				platform: "darwin",
				root: join(homeDirectory, "Library", "Application Support"),
			},
			{
				environment: { APPDATA: join(homeDirectory, "roaming") },
				platform: "win32",
				root: join(homeDirectory, "roaming"),
			},
		];

		for (const [index, fixture] of cases.entries()) {
			const expected = await writeProfileCache(fixture.root, "T3 Code", [
				{
					environmentId: `environment-${index}`,
					sequence: 1,
					updatedAt: "2030-01-01T00:00:00.000Z",
				},
			]);
			assert.deepEqual(
				await discoverT3CacheDirectories({
					environment: fixture.environment,
					homeDirectory,
					platform: fixture.platform,
				}),
				[expected],
			);
		}
	});

	test("ignores a relative XDG_CONFIG_HOME", async (context) => {
		const homeDirectory = await cacheDirectory(context);
		const expected = await writeProfileCache(join(homeDirectory, ".config"), "T3 Code", [
			{
				environmentId: "local-environment",
				sequence: 1,
				updatedAt: "2030-01-01T00:00:00.000Z",
			},
		]);
		assert.deepEqual(
			await discoverT3CacheDirectories({
				environment: { XDG_CONFIG_HOME: "relative/config" },
				homeDirectory,
				platform: "linux",
			}),
			[expected],
		);
	});

	test("rejects an excessive number of T3 profile directories", async (context) => {
		const configDirectory = await cacheDirectory(context);
		for (let index = 0; index < 17; index += 1) {
			await mkdir(join(configDirectory, `T3 Code (Channel-${index})`));
		}
		await assert.rejects(
			discoverT3CacheDirectories({ configDirectory }),
			(error: unknown) => error instanceof T3CacheError && error.code === "unsupported",
		);
	});

	test("stops profile discovery after the fixed total-entry budget", async () => {
		const directory = fakeDirectory(
			Array.from({ length: 1_025 }, (_, index) => `unrelated-${index}`),
			{ directories: true },
		);

		await assert.rejects(
			discoverT3CacheDirectories({ configDirectory: "/untrusted-config" }, directory.open),
			(error: unknown) => error instanceof T3CacheError && error.code === "unsupported",
		);
		assert.deepEqual(directory.state, { closes: 1, reads: 1_025 });
	});

	test("selects the one profile containing the live local environment", async (context) => {
		const configDirectory = await cacheDirectory(context);
		await writeProfileCache(configDirectory, "T3 Code (Alpha)", [
			{
				environmentId: "old-environment",
				sequence: 50,
				updatedAt: "2031-01-01T00:00:00.000Z",
			},
		]);
		await writeProfileCache(configDirectory, "T3 Code", [
			{
				environmentId: "local-environment",
				sequence: 2,
				updatedAt: "2030-01-01T00:00:00.000Z",
			},
			{
				environmentId: "remote-environment",
				sequence: 3,
				updatedAt: "2030-01-01T00:00:01.000Z",
			},
		]);

		const cached = await readT3ShellCache({
			configDirectory,
			environmentId: "local-environment",
		});
		assert.deepEqual(
			cached.map(({ environmentId }) => environmentId),
			["local-environment", "remote-environment"],
		);
	});

	test("uses the freshest local snapshot when two channels contain the same environment", async (context) => {
		const configDirectory = await cacheDirectory(context);
		await writeProfileCache(configDirectory, "T3 Code (Alpha)", [
			{
				environmentId: "local-environment",
				sequence: 20,
				updatedAt: "2030-01-01T00:00:00.000Z",
			},
			{
				environmentId: "alpha-remote",
				sequence: 100,
				updatedAt: "2032-01-01T00:00:00.000Z",
			},
		]);
		await writeProfileCache(configDirectory, "T3 Code (Beta)", [
			{
				environmentId: "local-environment",
				sequence: 1,
				updatedAt: "2030-01-02T00:00:00.000Z",
			},
			{
				environmentId: "beta-remote",
				sequence: 2,
				updatedAt: "2030-01-02T00:00:01.000Z",
			},
		]);

		const cached = await readT3ShellCache({
			configDirectory,
			environmentId: "local-environment",
		});
		assert.deepEqual(
			cached.map(({ environmentId }) => environmentId),
			["beta-remote", "local-environment"],
		);
		assert.equal(
			cached.some(({ environmentId }) => environmentId === "alpha-remote"),
			false,
		);
	});

	test("honors explicit and environment cache overrides without merging them", async (context) => {
		const root = await cacheDirectory(context);
		const environmentDirectory = await writeProfileCache(root, "environment-override", [
			{
				environmentId: "from-environment",
				sequence: 1,
				updatedAt: "2030-01-01T00:00:00.000Z",
			},
		]);
		const explicitDirectory = await writeProfileCache(root, "explicit-override", [
			{
				environmentId: "from-explicit-option",
				sequence: 1,
				updatedAt: "2030-01-01T00:00:00.000Z",
			},
		]);

		assert.deepEqual(
			(await readT3ShellCache({ environment: { T3CODE_CACHE_DIR: environmentDirectory } })).map(
				({ environmentId }) => environmentId,
			),
			["from-environment"],
		);
		assert.deepEqual(
			(
				await readT3ShellCache({
					directory: explicitDirectory,
					environment: { T3CODE_CACHE_DIR: environmentDirectory },
				})
			).map(({ environmentId }) => environmentId),
			["from-explicit-option"],
		);
	});

	test("reports a missing profile root or live-environment match as unavailable", async (context) => {
		const root = await cacheDirectory(context);
		await assert.rejects(
			discoverT3CacheDirectories({ configDirectory: join(root, "missing") }),
			(error: unknown) => error instanceof T3CacheError && error.code === "unavailable",
		);
		const explicitDirectory = await writeProfileCache(root, "T3 Code (Alpha)", [
			{
				environmentId: "some-other-environment",
				sequence: 1,
				updatedAt: "2030-01-01T00:00:00.000Z",
			},
		]);
		await assert.rejects(
			readT3ShellCache({ configDirectory: root, environmentId: "local-environment" }),
			(error: unknown) => error instanceof T3CacheError && error.code === "unavailable",
		);
		await assert.rejects(
			readT3ShellCache({ directory: explicitDirectory, environmentId: "local-environment" }),
			(error: unknown) => error instanceof T3CacheError && error.code === "unavailable",
		);
	});
});
