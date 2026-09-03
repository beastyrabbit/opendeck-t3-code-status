import { type BigIntStats, constants as fileConstants } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { endianness, homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";

// snappyjs intentionally has no bundled TypeScript declarations.
// @ts-expect-error -- narrowed immediately to the two functions used here.
import * as snappyModule from "snappyjs";

import type { T3ShellSnapshot } from "./types.js";

const DATABASE_ID = 1;
const SHELL_STORE_ID = 2;
const OBJECT_STORE_DATA_INDEX_ID = 1;
const BLOB_ENTRY_INDEX_ID = 3;
const LEVELDB_TABLE_FOOTER_BYTES = 48;
const LEVELDB_TABLE_MAGIC = Buffer.from("57fb808b247547db", "hex");
const LEVELDB_LOG_BLOCK_BYTES = 32 * 1024;
const LEVELDB_LOG_HEADER_BYTES = 7;
const MAX_DATABASE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DATABASE_FILES = 256;
const MAX_DATABASE_DIRECTORY_ENTRIES = 4_096;
const MAX_DATABASE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_DECOMPRESSED_BLOCK_BYTES = 64 * 1024 * 1024;
const MAX_TRANSIENT_ALLOCATION_BYTES = 256 * 1024 * 1024;
const MAX_ENVIRONMENT_ID_CODE_UNITS = 1_024;
const MAX_INDEXED_DB_SHELL_KEY_BYTES = 1 + 8 + 8 + 4 + 1 + 10 + MAX_ENVIRONMENT_ID_CODE_UNITS * 2;
const MAX_STORED_SHELL_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SHELL_JSON_BYTES = 8 * 1024 * 1024;
const JSON_PARSE_ALLOCATION_MULTIPLIER = 32;
const MAX_PARSED_ENTRIES = 250_000;
const MAX_TABLE_BLOCKS = 32_768;
const MAX_T3_PROFILES = 16;
const MAX_CONFIG_DIRECTORY_ENTRIES = 1_024;
const MAX_THREADS_PER_SNAPSHOT = 10_000;
const READ_ATTEMPTS = 3;
const T3_USER_DATA_DIRECTORY = /^(?:t3code|T3 Code(?: \([^/()]+\))?)$/i;
const T3_INDEXED_DB_DIRECTORY = ["IndexedDB", "t3code_app_0.indexeddb.leveldb"] as const;
const CRC32C_POLYNOMIAL = 0x82f63b78;
const CRC32C_MASK_DELTA = 0xa282ead8;
const LATEST_TURN_STATES = new Set(["running", "interrupted", "completed", "error"]);
const V8_VERSION_TAG = 0xff;
const V8_PADDING_TAG = 0x00;
const V8_UTF8_STRING_TAG = 0x53;
const V8_ONE_BYTE_STRING_TAG = 0x22;
const V8_TWO_BYTE_STRING_TAG = 0x63;
const SUPPORTED_V8_SERIALIZATION_VERSIONS = new Set([15, 16]);
const EXTERNAL_VALUE_MARKER = Buffer.from([0xff, 0x11, 0x01]);
const COMPRESSED_VALUE_MARKER = Buffer.from([0xff, 0x11, 0x02]);
const EXTERNAL_OBJECT_BLOB = 0;
const EXTERNAL_OBJECT_FILE = 1;
const EXTERNAL_OBJECT_FILE_SYSTEM_ACCESS_HANDLE = 2;
const MINIMUM_BLOB_NUMBER = 2n;
const MAX_SIGNED_INT64 = 0x7fff_ffff_ffff_ffffn;
const WRAPPER_BLOB_MIME_TYPE = "application/vnd.blink-idb-value-wrapper";
const INDEXED_DB_LEVELDB_SUFFIX = ".indexeddb.leveldb";
const READ_ONLY_FILE_FLAGS =
	process.platform === "win32"
		? fileConstants.O_RDONLY
		: fileConstants.O_RDONLY | fileConstants.O_NONBLOCK | fileConstants.O_NOFOLLOW;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const CRC32C_TABLE = new Uint32Array(256);
for (let value = 0; value < CRC32C_TABLE.length; value += 1) {
	let remainder = value;
	for (let bit = 0; bit < 8; bit += 1) {
		remainder = (remainder >>> 1) ^ ((remainder & 1) === 1 ? CRC32C_POLYNOMIAL : 0);
	}
	CRC32C_TABLE[value] = remainder >>> 0;
}

interface SnappyApi {
	compress(input: Uint8Array): Uint8Array;
	uncompress(input: Uint8Array, maxLength?: number): Uint8Array;
}

const snappy = snappyModule as unknown as SnappyApi;

export interface CachedT3Shell {
	environmentId: string;
	snapshot: T3ShellSnapshot;
}

export interface ReadT3ShellCacheOptions {
	configDirectory?: string;
	directory?: string;
	environment?: Readonly<Record<string, string | undefined>>;
	environmentId?: string;
	homeDirectory?: string;
	platform?: NodeJS.Platform;
}

export type T3CacheErrorCode = "corrupt" | "inconsistent" | "unavailable" | "unsupported";

export class T3CacheError extends Error {
	constructor(
		readonly code: T3CacheErrorCode,
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "T3CacheError";
	}
}

export interface LevelDbRecord {
	key: Buffer;
	offset: number;
	recordType: 0 | 1;
	sequence: bigint;
	value: Buffer;
}

export interface IndexedDbKeyPrefix {
	bytesRead: number;
	databaseId: number;
	indexId: number;
	objectStoreId: number;
}

interface BlockHandle {
	offset: number;
	size: number;
}

interface DecodedVarint {
	bytesRead: number;
	value: number;
}

interface StoredShellValue {
	environmentId: string;
	schemaVersion: 1;
	snapshot: T3ShellSnapshot;
}

interface ExternalShellValue {
	blobIndex: number;
	blobSize: number;
}

interface ExternalWrapperBlob {
	blobNumber: number;
	size: number;
}

interface LatestShellData {
	keyIdentity: string;
	record: LevelDbRecord;
}

interface LatestShellRecords {
	blobEntries: Map<string, LevelDbRecord>;
	data: Map<string, LatestShellData>;
}

interface ReadInputBudget {
	remainingBytes: number;
}

interface RawTableBlockEntry {
	key: Buffer;
	offset: number;
	value: Buffer;
}

export interface T3CacheAllocationBudget {
	remainingBlocks: number;
	remainingBytes: number;
	remainingEntries: number;
}

interface TableBlockRange {
	end: number;
	start: number;
}

type ClaimedTableBlocks = Map<number, TableBlockRange[]>;

type LevelDbRecordFilter = (key: Uint8Array) => boolean;

const includeEveryRecord: LevelDbRecordFilter = () => true;

interface CachedT3Profile {
	directory: string;
	shells: CachedT3Shell[];
}

interface DirectoryEntry {
	name: string;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

interface DirectoryHandle {
	read(): Promise<DirectoryEntry | null>;
	close(): Promise<void>;
}

type OpenDirectory = (path: string) => Promise<DirectoryHandle>;

export function createT3CacheAllocationBudget(
	limitBytes = MAX_TRANSIENT_ALLOCATION_BYTES,
	limitEntries = MAX_PARSED_ENTRIES,
	limitBlocks = MAX_TABLE_BLOCKS,
): T3CacheAllocationBudget {
	if (![limitBytes, limitEntries, limitBlocks].every((value) => Number.isSafeInteger(value) && value >= 0)) {
		return fail("unsupported");
	}
	return { remainingBlocks: limitBlocks, remainingBytes: limitBytes, remainingEntries: limitEntries };
}

function reserveAllocation(budget: T3CacheAllocationBudget, bytes: number): void {
	if (!Number.isSafeInteger(bytes) || bytes < 0) fail("corrupt");
	if (bytes > budget.remainingBytes) fail("unsupported");
	budget.remainingBytes -= bytes;
}

function appendRecords(target: LevelDbRecord[], source: readonly LevelDbRecord[]): void {
	for (const record of source) target.push(record);
}

function consumeEntry(budget: T3CacheAllocationBudget): void {
	if (budget.remainingEntries === 0) fail("unsupported");
	budget.remainingEntries -= 1;
}

function claimTableBlock(
	table: Buffer,
	handle: BlockHandle,
	budget: T3CacheAllocationBudget,
	claimed: ClaimedTableBlocks,
): void {
	if (budget.remainingBlocks === 0) fail("unsupported");
	const end = handle.offset + handle.size + 5;
	if (!Number.isSafeInteger(end) || end > table.length - LEVELDB_TABLE_FOOTER_BYTES) fail("corrupt");
	const firstPage = Math.floor(handle.offset / 4096);
	const lastPage = Math.floor((end - 1) / 4096);
	for (let page = firstPage; page <= lastPage; page += 1) {
		if (claimed.get(page)?.some((range) => handle.offset < range.end && end > range.start)) {
			fail("corrupt");
		}
	}
	budget.remainingBlocks -= 1;
	const range = { end, start: handle.offset };
	for (let page = firstPage; page <= lastPage; page += 1) {
		const ranges = claimed.get(page);
		if (ranges) ranges.push(range);
		else claimed.set(page, [range]);
	}
}

function defaultConfigDirectory(
	platform: NodeJS.Platform,
	environment: Readonly<Record<string, string | undefined>>,
	homeDirectory: string,
): string {
	let configHome: string;
	if (platform === "win32") {
		configHome = environment.APPDATA?.trim() || resolve(homeDirectory, "AppData", "Roaming");
	} else if (platform === "darwin") {
		configHome = resolve(homeDirectory, "Library", "Application Support");
	} else {
		const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
		configHome =
			xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : resolve(homeDirectory, ".config");
	}
	return resolve(configHome);
}

function fail(code: T3CacheErrorCode, cause?: unknown): never {
	throw new T3CacheError(code, cause === undefined ? undefined : { cause });
}

function assertRange(buffer: Uint8Array, offset: number, length: number): void {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
		fail("corrupt");
	}
	if (offset + length > buffer.length) fail("inconsistent");
}

export function crc32c(buffer: Uint8Array): number {
	return crc32cParts([buffer]);
}

function crc32cParts(parts: readonly Uint8Array[]): number {
	let checksum = 0xffffffff;
	for (const buffer of parts) {
		for (const byte of buffer) {
			const tableIndex = (checksum ^ byte) & 0xff;
			checksum = (checksum >>> 8) ^ (CRC32C_TABLE[tableIndex] ?? 0);
		}
	}
	return (checksum ^ 0xffffffff) >>> 0;
}

export function maskLevelDbCrc32c(checksum: number): number {
	return (((checksum >>> 15) | (checksum << 17)) + CRC32C_MASK_DELTA) >>> 0;
}

function validateLevelDbChecksum(storedChecksum: number, protectedBytes: Uint8Array): void {
	if (storedChecksum !== maskLevelDbCrc32c(crc32c(protectedBytes))) fail("corrupt");
}

function validateLevelDbLogChecksum(
	storedChecksum: number,
	physicalType: number,
	contents: Uint8Array,
): void {
	if (storedChecksum !== maskLevelDbCrc32c(crc32cParts([Uint8Array.of(physicalType), contents]))) {
		fail("corrupt");
	}
}

export function decodeLevelDbVarint(buffer: Uint8Array, offset = 0): DecodedVarint {
	let value = 0;
	let multiplier = 1;
	for (let index = 0; index < 10; index += 1) {
		assertRange(buffer, offset + index, 1);
		const byte = buffer[offset + index];
		if (byte === undefined) fail("inconsistent");
		value += (byte & 0x7f) * multiplier;
		if (!Number.isSafeInteger(value)) fail("unsupported");
		if ((byte & 0x80) === 0) return { bytesRead: index + 1, value };
		multiplier *= 128;
	}
	return fail("corrupt");
}

function readUnsignedLittleEndian(buffer: Uint8Array, offset: number, length: number): number {
	assertRange(buffer, offset, length);
	let value = 0;
	let multiplier = 1;
	for (let index = 0; index < length; index += 1) {
		value += (buffer[offset + index] ?? 0) * multiplier;
		multiplier *= 256;
	}
	if (!Number.isSafeInteger(value)) fail("unsupported");
	return value;
}

export function parseIndexedDbKeyPrefix(key: Uint8Array): IndexedDbKeyPrefix {
	assertRange(key, 0, 1);
	const header = key[0];
	if (header === undefined) return fail("corrupt");
	const databaseIdBytes = ((header & 0xe0) >> 5) + 1;
	const objectStoreIdBytes = ((header & 0x1c) >> 2) + 1;
	const indexIdBytes = (header & 0x03) + 1;
	let offset = 1;
	const databaseId = readUnsignedLittleEndian(key, offset, databaseIdBytes);
	offset += databaseIdBytes;
	const objectStoreId = readUnsignedLittleEndian(key, offset, objectStoreIdBytes);
	offset += objectStoreIdBytes;
	const indexId = readUnsignedLittleEndian(key, offset, indexIdBytes);
	offset += indexIdBytes;
	return { bytesRead: offset, databaseId, indexId, objectStoreId };
}

type ShellRecordKind = "blob-entry" | "data";

function shellRecordKind(key: Uint8Array): ShellRecordKind | undefined {
	const prefix = parseIndexedDbKeyPrefix(key);
	if (prefix.databaseId !== DATABASE_ID || prefix.objectStoreId !== SHELL_STORE_ID) return undefined;
	if (prefix.indexId === OBJECT_STORE_DATA_INDEX_ID) return "data";
	if (prefix.indexId === BLOB_ENTRY_INDEX_ID) return "blob-entry";
	return undefined;
}

function isShellObjectStoreKey(key: Uint8Array): boolean {
	const isShellData = shellRecordKind(key) === "data";
	if (isShellData && key.length > MAX_INDEXED_DB_SHELL_KEY_BYTES) return fail("unsupported");
	return isShellData;
}

function isShellCacheKey(key: Uint8Array): boolean {
	const isShellRecord = shellRecordKind(key) !== undefined;
	if (isShellRecord && key.length > MAX_INDEXED_DB_SHELL_KEY_BYTES) return fail("unsupported");
	return isShellRecord;
}

function shellUserKeyIdentity(key: Buffer, budget: T3CacheAllocationBudget): string {
	const prefix = parseIndexedDbKeyPrefix(key);
	const suffix = key.subarray(prefix.bytesRead);
	// Hex contains two JavaScript code units per source byte.
	reserveAllocation(budget, suffix.length * 4);
	return suffix.toString("hex");
}

export function decodeIndexedDbStringKey(
	key: Uint8Array,
	budget: T3CacheAllocationBudget = createT3CacheAllocationBudget(),
): string {
	const prefix = parseIndexedDbKeyPrefix(key);
	let offset = prefix.bytesRead;
	assertRange(key, offset, 1);
	// Chromium IndexedDB key type 1 is a string.
	if (key[offset] !== 1) return fail("unsupported");
	offset += 1;
	const length = decodeLevelDbVarint(key, offset);
	offset += length.bytesRead;
	if (length.value > MAX_ENVIRONMENT_ID_CODE_UNITS) return fail("unsupported");
	const encodedBytes = length.value * 2;
	assertRange(key, offset, encodedBytes);
	if (offset + encodedBytes !== key.length) return fail("corrupt");
	reserveAllocation(budget, encodedBytes * 2);
	const codeUnits = new Uint16Array(length.value);
	for (let index = 0; index < length.value; index += 1) {
		const high = key[offset + index * 2] ?? 0;
		const low = key[offset + index * 2 + 1] ?? 0;
		codeUnits[index] = high * 256 + low;
	}
	return String.fromCharCode(...codeUnits);
}

function decodeBlockHandle(buffer: Uint8Array, offset: number): { bytesRead: number; handle: BlockHandle } {
	const decodedOffset = decodeLevelDbVarint(buffer, offset);
	const decodedSize = decodeLevelDbVarint(buffer, offset + decodedOffset.bytesRead);
	return {
		bytesRead: decodedOffset.bytesRead + decodedSize.bytesRead,
		handle: { offset: decodedOffset.value, size: decodedSize.value },
	};
}

function decompressSnappy(
	buffer: Uint8Array,
	budget: T3CacheAllocationBudget,
	maxDecompressedBytes = MAX_DECOMPRESSED_BLOCK_BYTES,
): Buffer {
	let decompressedBytes: number;
	try {
		decompressedBytes = decodeLevelDbVarint(buffer, 0).value;
	} catch (cause) {
		if (cause instanceof T3CacheError) throw cause;
		return fail("corrupt", cause);
	}
	if (decompressedBytes > maxDecompressedBytes) return fail("unsupported");
	reserveAllocation(budget, decompressedBytes);
	try {
		const result = snappy.uncompress(buffer, decompressedBytes);
		const decompressed = Buffer.isBuffer(result) ? result : Buffer.from(result);
		if (decompressed.length !== decompressedBytes) return fail("corrupt");
		return decompressed;
	} catch (cause) {
		if (cause instanceof T3CacheError) throw cause;
		return fail("corrupt", cause);
	}
}

function readTableBlock(
	table: Buffer,
	handle: BlockHandle,
	budget: T3CacheAllocationBudget,
	claimed: ClaimedTableBlocks,
): Buffer {
	claimTableBlock(table, handle, budget, claimed);
	assertRange(table, handle.offset, handle.size + 5);
	const contents = table.subarray(handle.offset, handle.offset + handle.size);
	const compression = table[handle.offset + handle.size];
	if (compression === undefined) return fail("inconsistent");
	const storedChecksum = table.readUInt32LE(handle.offset + handle.size + 1);
	validateLevelDbChecksum(storedChecksum, table.subarray(handle.offset, handle.offset + handle.size + 1));
	if (compression === 0) return contents;
	if (compression === 1) return decompressSnappy(contents, budget);
	return fail("unsupported");
}

function parseRawTableBlock(
	block: Buffer,
	blockOffset: number,
	includeEntry: (key: Buffer) => boolean = includeEveryRecord,
	budget: T3CacheAllocationBudget = createT3CacheAllocationBudget(),
): RawTableBlockEntry[] {
	assertRange(block, block.length - 4, 4);
	const restartCount = block.readUInt32LE(block.length - 4);
	const recordsEnd = block.length - (restartCount + 1) * 4;
	if (recordsEnd < 0) return fail("corrupt");
	let offset = restartCount > 0 ? block.readUInt32LE(recordsEnd) : 0;
	if (offset > recordsEnd) return fail("corrupt");
	let previousKey = Buffer.alloc(0);
	const records: RawTableBlockEntry[] = [];

	while (offset < recordsEnd) {
		consumeEntry(budget);
		const recordOffset = offset;
		const shared = decodeLevelDbVarint(block, offset);
		offset += shared.bytesRead;
		const unshared = decodeLevelDbVarint(block, offset);
		offset += unshared.bytesRead;
		const valueLength = decodeLevelDbVarint(block, offset);
		offset += valueLength.bytesRead;
		if (shared.value > previousKey.length) return fail("corrupt");
		assertRange(block, offset, unshared.value + valueLength.value);
		reserveAllocation(budget, shared.value + unshared.value);
		const key = Buffer.concat([
			previousKey.subarray(0, shared.value),
			block.subarray(offset, offset + unshared.value),
		]);
		offset += unshared.value;
		const included = includeEntry(key);
		if (included) {
			reserveAllocation(budget, valueLength.value);
			records.push({
				key,
				offset: blockOffset + recordOffset,
				value: Buffer.from(block.subarray(offset, offset + valueLength.value)),
			});
		}
		offset += valueLength.value;
		previousKey = key;
	}
	if (offset !== recordsEnd) return fail("corrupt");
	return records;
}

function parseInternalKey(key: Buffer): {
	key: Buffer;
	recordType: 0 | 1;
	sequence: bigint;
} {
	if (key.length < 8) return fail("corrupt");
	const packed = key.readBigUInt64LE(key.length - 8);
	const rawRecordType = Number(packed & 0xffn);
	if (rawRecordType !== 0 && rawRecordType !== 1) return fail("unsupported");
	return {
		key: key.subarray(0, -8),
		recordType: rawRecordType,
		sequence: packed >> 8n,
	};
}

function parseTableBlock(
	block: Buffer,
	blockOffset: number,
	recordFilter: LevelDbRecordFilter,
	budget: T3CacheAllocationBudget,
): LevelDbRecord[] {
	const rawRecords = parseRawTableBlock(
		block,
		blockOffset,
		(internalKey) => {
			const parsed = parseInternalKey(internalKey);
			return recordFilter(parsed.key);
		},
		budget,
	);
	return rawRecords.map((record) => {
		const parsed = parseInternalKey(record.key);
		return {
			key: parsed.key,
			offset: record.offset,
			recordType: parsed.recordType,
			sequence: parsed.sequence,
			value: record.value,
		};
	});
}

export function parseLevelDbTable(
	table: Uint8Array,
	recordFilter: LevelDbRecordFilter = includeEveryRecord,
	budget: T3CacheAllocationBudget = createT3CacheAllocationBudget(),
): LevelDbRecord[] {
	if (!Buffer.isBuffer(table)) reserveAllocation(budget, table.byteLength);
	const buffer = Buffer.isBuffer(table) ? table : Buffer.from(table);
	const claimedBlocks: ClaimedTableBlocks = new Map();
	if (buffer.length < LEVELDB_TABLE_FOOTER_BYTES) return fail("inconsistent");
	if (!buffer.subarray(-LEVELDB_TABLE_MAGIC.length).equals(LEVELDB_TABLE_MAGIC)) {
		return fail("corrupt");
	}
	let footerOffset = buffer.length - LEVELDB_TABLE_FOOTER_BYTES;
	const metaHandle = decodeBlockHandle(buffer, footerOffset);
	footerOffset += metaHandle.bytesRead;
	const indexHandle = decodeBlockHandle(buffer, footerOffset).handle;
	const metaEntries = parseRawTableBlock(
		readTableBlock(buffer, metaHandle.handle, budget, claimedBlocks),
		metaHandle.handle.offset,
		includeEveryRecord,
		budget,
	);
	for (const metaEntry of metaEntries) {
		const referencedHandle = decodeBlockHandle(metaEntry.value, 0).handle;
		// Filter/property blocks are not needed for sequential recovery, but their
		// checksum still belongs to this table and must be verified.
		readTableBlock(buffer, referencedHandle, budget, claimedBlocks);
	}
	const indexRecords = parseRawTableBlock(
		readTableBlock(buffer, indexHandle, budget, claimedBlocks),
		indexHandle.offset,
		includeEveryRecord,
		budget,
	);
	const records: LevelDbRecord[] = [];
	for (const indexRecord of indexRecords) {
		const dataHandle = decodeBlockHandle(indexRecord.value, 0).handle;
		appendRecords(
			records,
			parseTableBlock(
				readTableBlock(buffer, dataHandle, budget, claimedBlocks),
				dataHandle.offset,
				recordFilter,
				budget,
			),
		);
	}
	return records;
}

function parseWriteBatch(
	batch: Buffer,
	baseOffset: number,
	recordFilter: LevelDbRecordFilter,
	budget: T3CacheAllocationBudget,
): LevelDbRecord[] {
	assertRange(batch, 0, 12);
	const firstSequence = batch.readBigUInt64LE(0);
	const count = batch.readUInt32LE(8);
	let offset = 12;
	const records: LevelDbRecord[] = [];
	for (let index = 0; index < count; index += 1) {
		consumeEntry(budget);
		const recordOffset = offset;
		assertRange(batch, offset, 1);
		const rawRecordType = batch[offset];
		offset += 1;
		if (rawRecordType !== 0 && rawRecordType !== 1) return fail("unsupported");
		const keyLength = decodeLevelDbVarint(batch, offset);
		offset += keyLength.bytesRead;
		assertRange(batch, offset, keyLength.value);
		const keyBytes = batch.subarray(offset, offset + keyLength.value);
		offset += keyLength.value;
		const included = recordFilter(keyBytes);
		let valueOffset = 0;
		let includedValueLength = 0;
		if (rawRecordType === 1) {
			const valueLength = decodeLevelDbVarint(batch, offset);
			offset += valueLength.bytesRead;
			assertRange(batch, offset, valueLength.value);
			if (included) {
				valueOffset = offset;
				includedValueLength = valueLength.value;
			}
			offset += valueLength.value;
		}
		if (!included) continue;
		reserveAllocation(budget, keyBytes.length + includedValueLength);
		records.push({
			key: Buffer.from(keyBytes),
			offset: baseOffset + recordOffset,
			recordType: rawRecordType,
			sequence: firstSequence + BigInt(index),
			value: Buffer.from(batch.subarray(valueOffset, valueOffset + includedValueLength)),
		});
	}
	if (offset !== batch.length) return fail("corrupt");
	return records;
}

export function parseLevelDbLog(
	log: Uint8Array,
	recordFilter: LevelDbRecordFilter = includeEveryRecord,
	budget: T3CacheAllocationBudget = createT3CacheAllocationBudget(),
): LevelDbRecord[] {
	if (!Buffer.isBuffer(log)) reserveAllocation(budget, log.byteLength);
	const buffer = Buffer.isBuffer(log) ? log : Buffer.from(log);
	const records: LevelDbRecord[] = [];
	let fragments: Buffer[] | undefined;
	let fragmentedOffset = 0;

	for (let blockOffset = 0; blockOffset < buffer.length; blockOffset += LEVELDB_LOG_BLOCK_BYTES) {
		const blockEnd = Math.min(blockOffset + LEVELDB_LOG_BLOCK_BYTES, buffer.length);
		let offset = blockOffset;
		while (offset + LEVELDB_LOG_HEADER_BYTES <= blockEnd) {
			consumeEntry(budget);
			const storedChecksum = buffer.readUInt32LE(offset);
			const length = buffer.readUInt16LE(offset + 4);
			const physicalType = buffer[offset + 6];
			if (length === 0 && physicalType === 0) break;
			if (offset + LEVELDB_LOG_HEADER_BYTES + length > blockEnd) {
				if (blockEnd === buffer.length) break;
				return fail("corrupt");
			}
			const contentsOffset = offset + LEVELDB_LOG_HEADER_BYTES;
			const contents = buffer.subarray(contentsOffset, contentsOffset + length);
			offset = contentsOffset + length;
			if (physicalType === undefined) return fail("inconsistent");
			validateLevelDbLogChecksum(storedChecksum, physicalType, contents);

			if (physicalType === 1) {
				if (fragments !== undefined) return fail("corrupt");
				fragments = undefined;
				appendRecords(records, parseWriteBatch(contents, contentsOffset, recordFilter, budget));
			} else if (physicalType === 2) {
				if (fragments !== undefined) return fail("corrupt");
				fragments = [contents];
				fragmentedOffset = contentsOffset;
			} else if (physicalType === 3) {
				if (fragments === undefined) return fail("corrupt");
				fragments.push(contents);
			} else if (physicalType === 4) {
				if (fragments === undefined) return fail("corrupt");
				fragments.push(contents);
				const fragmentedBytes = fragments.reduce((sum, fragment) => sum + fragment.length, 0);
				reserveAllocation(budget, fragmentedBytes);
				appendRecords(
					records,
					parseWriteBatch(Buffer.concat(fragments), fragmentedOffset, recordFilter, budget),
				);
				fragments = undefined;
			} else {
				return fail("unsupported");
			}
		}
	}
	// An append observed between writes may end in FIRST/MIDDLE. Its last batch
	// was not committed as a complete physical record in this read and is ignored.
	return records;
}

function decodeV8Uint32Varint(buffer: Uint8Array, offset: number): DecodedVarint {
	let value = 0;
	for (let index = 0; index < 5; index += 1) {
		const byte = buffer[offset + index];
		if (byte === undefined) return fail("corrupt");
		const payload = byte & 0x7f;
		if (index === 4 && payload > 0x0f) return fail("corrupt");
		value += payload * 2 ** (index * 7);
		if ((byte & 0x80) === 0) {
			if (index > 0 && payload === 0) return fail("corrupt");
			return { bytesRead: index + 1, value };
		}
	}
	return fail("corrupt");
}

function decodeCanonicalUint64Varint(
	buffer: Uint8Array,
	offset: number,
): { bytesRead: number; value: bigint } {
	let value = 0n;
	for (let index = 0; index < 10; index += 1) {
		const byte = buffer[offset + index];
		if (byte === undefined) return fail("corrupt");
		const payload = byte & 0x7f;
		if (index === 9 && payload > 1) return fail("corrupt");
		value |= BigInt(payload) << BigInt(index * 7);
		if ((byte & 0x80) === 0) {
			if (index > 0 && payload === 0) return fail("corrupt");
			if (value > MAX_SIGNED_INT64) return fail("corrupt");
			return { bytesRead: index + 1, value };
		}
	}
	return fail("corrupt");
}

function metadataString(
	buffer: Uint8Array,
	offset: number,
): { bytesRead: number; isWrapperMimeType: boolean } {
	const length = decodeCanonicalUint64Varint(buffer, offset);
	const contentsOffset = offset + length.bytesRead;
	const remainingCodeUnits = Math.floor((buffer.length - contentsOffset) / 2);
	if (length.value > BigInt(remainingCodeUnits)) return fail("corrupt");
	const codeUnits = Number(length.value);
	let isWrapperMimeType = codeUnits === WRAPPER_BLOB_MIME_TYPE.length;
	if (isWrapperMimeType) {
		for (let index = 0; index < WRAPPER_BLOB_MIME_TYPE.length; index += 1) {
			const encodedCodeUnit =
				(buffer[contentsOffset + index * 2] ?? 0) * 256 + (buffer[contentsOffset + index * 2 + 1] ?? 0);
			if (encodedCodeUnit !== WRAPPER_BLOB_MIME_TYPE.charCodeAt(index)) {
				isWrapperMimeType = false;
				break;
			}
		}
	}
	return { bytesRead: length.bytesRead + codeUnits * 2, isWrapperMimeType };
}

function skipMetadataBytes(buffer: Uint8Array, offset: number): number {
	const length = decodeCanonicalUint64Varint(buffer, offset);
	const contentsOffset = offset + length.bytesRead;
	if (length.value > BigInt(buffer.length - contentsOffset)) return fail("corrupt");
	return length.bytesRead + Number(length.value);
}

function parseExternalWrapperBlob(
	metadata: Uint8Array,
	targetBlobIndex: number,
	budget: T3CacheAllocationBudget,
): ExternalWrapperBlob {
	let offset = 0;
	let blobIndex = 0;
	let wrapperMimeTypeCount = 0;
	let wrapper: { blobNumber: bigint; size: bigint } | undefined;
	while (offset < metadata.length) {
		consumeEntry(budget);
		const objectType = metadata[offset];
		offset += 1;
		if (objectType === EXTERNAL_OBJECT_BLOB || objectType === EXTERNAL_OBJECT_FILE) {
			const blobNumber = decodeCanonicalUint64Varint(metadata, offset);
			offset += blobNumber.bytesRead;
			if (blobNumber.value < MINIMUM_BLOB_NUMBER) return fail("corrupt");
			const mimeType = metadataString(metadata, offset);
			offset += mimeType.bytesRead;
			const size = decodeCanonicalUint64Varint(metadata, offset);
			offset += size.bytesRead;
			if (objectType === EXTERNAL_OBJECT_BLOB && mimeType.isWrapperMimeType) {
				wrapperMimeTypeCount += 1;
			}

			if (blobIndex === targetBlobIndex) {
				if (objectType !== EXTERNAL_OBJECT_BLOB || !mimeType.isWrapperMimeType) {
					return fail("corrupt");
				}
				wrapper = { blobNumber: blobNumber.value, size: size.value };
			} else if (wrapper !== undefined) {
				// Chromium appends the wrapper as the last Blob/File external object.
				return fail("corrupt");
			}
			blobIndex += 1;

			if (objectType === EXTERNAL_OBJECT_FILE) {
				const filename = metadataString(metadata, offset);
				offset += filename.bytesRead;
				const lastModified = decodeCanonicalUint64Varint(metadata, offset);
				offset += lastModified.bytesRead;
			}
		} else if (objectType === EXTERNAL_OBJECT_FILE_SYSTEM_ACCESS_HANDLE) {
			offset += skipMetadataBytes(metadata, offset);
		} else {
			return fail("corrupt");
		}
	}
	if (wrapper === undefined || wrapperMimeTypeCount !== 1) return fail("corrupt");
	if (wrapper.size > BigInt(MAX_STORED_SHELL_PAYLOAD_BYTES)) return fail("unsupported");
	if (wrapper.blobNumber > BigInt(Number.MAX_SAFE_INTEGER)) return fail("unsupported");
	return { blobNumber: Number(wrapper.blobNumber), size: Number(wrapper.size) };
}

function objectStoreWireData(rawValue: Uint8Array, budget: T3CacheAllocationBudget): Buffer<ArrayBufferLike> {
	const idbVersion = decodeLevelDbVarint(rawValue, 0);
	if (!Buffer.isBuffer(rawValue)) reserveAllocation(budget, rawValue.byteLength);
	const buffer = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue);
	return buffer.subarray(idbVersion.bytesRead);
}

function externalShellValue(
	rawValue: Uint8Array,
	budget: T3CacheAllocationBudget,
): ExternalShellValue | undefined {
	const wireData = objectStoreWireData(rawValue, budget);
	if (!wireData.subarray(0, EXTERNAL_VALUE_MARKER.length).equals(EXTERNAL_VALUE_MARKER)) {
		return undefined;
	}
	let offset = EXTERNAL_VALUE_MARKER.length;
	const blobSize = decodeV8Uint32Varint(wireData, offset);
	offset += blobSize.bytesRead;
	const blobIndex = decodeV8Uint32Varint(wireData, offset);
	offset += blobIndex.bytesRead;
	if (offset !== wireData.length) return fail("corrupt");
	if (blobSize.value > MAX_STORED_SHELL_PAYLOAD_BYTES) return fail("unsupported");
	return { blobIndex: blobIndex.value, blobSize: blobSize.value };
}

function decodePrimitiveV8String(
	serialized: Buffer<ArrayBufferLike>,
	budget: T3CacheAllocationBudget,
	globalOffset = 0,
): string {
	if (serialized[0] !== V8_VERSION_TAG) return fail("corrupt");
	const version = decodeV8Uint32Varint(serialized, 1);
	if (!SUPPORTED_V8_SERIALIZATION_VERSIONS.has(version.value)) return fail("unsupported");
	let offset = 1 + version.bytesRead;
	let hasPadding = false;
	if (serialized[offset] === V8_PADDING_TAG) {
		hasPadding = true;
		offset += 1;
	}

	const tag = serialized[offset];
	if (tag !== V8_UTF8_STRING_TAG && tag !== V8_ONE_BYTE_STRING_TAG && tag !== V8_TWO_BYTE_STRING_TAG) {
		return fail("corrupt");
	}
	offset += 1;
	const length = decodeV8Uint32Varint(serialized, offset);
	offset += length.bytesRead;
	if (length.value > MAX_STORED_SHELL_PAYLOAD_BYTES) return fail("unsupported");
	if (tag === V8_TWO_BYTE_STRING_TAG && length.value % 2 !== 0) return fail("corrupt");
	if (tag === V8_TWO_BYTE_STRING_TAG ? (globalOffset + offset) % 2 !== 0 : hasPadding) {
		return fail("corrupt");
	}
	if (offset + length.value !== serialized.length) return fail("corrupt");

	// A decoded JavaScript string can occupy two bytes per serialized byte.
	// On big-endian hosts, two-byte strings also need a byte-swapped copy.
	reserveAllocation(budget, serialized.length * 2);
	const encoded = serialized.subarray(offset);
	if (tag === V8_ONE_BYTE_STRING_TAG) return encoded.toString("latin1");
	if (tag === V8_TWO_BYTE_STRING_TAG) {
		if (endianness() === "LE") return encoded.toString("utf16le");
		return Buffer.from(encoded).swap16().toString("utf16le");
	}
	try {
		return UTF8_DECODER.decode(encoded);
	} catch (cause) {
		return fail("corrupt", cause);
	}
}

function unwrapBlinkWireData(wireData: Uint8Array, budget: T3CacheAllocationBudget): string {
	if (!Buffer.isBuffer(wireData)) reserveAllocation(budget, wireData.byteLength);
	let payload: Buffer<ArrayBufferLike> = Buffer.isBuffer(wireData) ? wireData : Buffer.from(wireData);
	if (payload.subarray(0, COMPRESSED_VALUE_MARKER.length).equals(COMPRESSED_VALUE_MARKER)) {
		payload = decompressSnappy(
			payload.subarray(COMPRESSED_VALUE_MARKER.length),
			budget,
			MAX_STORED_SHELL_PAYLOAD_BYTES,
		);
	}
	let start = 0;
	let end = payload.length;
	if (payload[0] === 0xff) {
		const blinkVersion = decodeLevelDbVarint(payload, 1);
		start = 1 + blinkVersion.bytesRead;
		if (blinkVersion.value >= 21) {
			assertRange(payload, start, 13);
			if (payload[start] !== 0xfe) return fail("corrupt");
			const trailerOffset = Number(payload.readBigUInt64BE(start + 1));
			const trailerSize = payload.readUInt32BE(start + 9);
			start += 13;
			if (trailerOffset !== 0 || trailerSize !== 0) {
				if (
					!Number.isSafeInteger(trailerOffset) ||
					trailerOffset < start ||
					trailerOffset > payload.length - trailerSize
				) {
					return fail("corrupt");
				}
				end = trailerOffset;
			}
		}
	}
	const serializedBytes = end - start;
	if (serializedBytes > MAX_STORED_SHELL_PAYLOAD_BYTES) return fail("unsupported");
	return decodePrimitiveV8String(payload.subarray(start, end), budget, start);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isOptionalNullableTimestamp(candidate: Record<string, unknown>, key: string): boolean {
	const value = candidate[key];
	return value === undefined || value === null || isTimestamp(value);
}

function isRequiredNullableTimestamp(candidate: Record<string, unknown>, key: string): boolean {
	const value = candidate[key];
	return value === null || isTimestamp(value);
}

function isLatestTurn(value: unknown): boolean {
	if (value === null) return true;
	if (!isRecord(value) || typeof value.state !== "string" || !LATEST_TURN_STATES.has(value.state)) {
		return false;
	}
	return (
		isOptionalNullableTimestamp(value, "requestedAt") &&
		isOptionalNullableTimestamp(value, "startedAt") &&
		isOptionalNullableTimestamp(value, "completedAt")
	);
}

function isThreadSession(value: unknown): boolean {
	if (value === null) return true;
	if (!isRecord(value) || typeof value.status !== "string" || value.status.length === 0) return false;
	return value.updatedAt === undefined || isTimestamp(value.updatedAt);
}

function isT3ThreadShell(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || value.id.length === 0) return false;
	if (value.interactionMode !== "default" && value.interactionMode !== "plan") return false;
	if (!isRequiredNullableTimestamp(value, "archivedAt")) return false;
	if (
		value.settledOverride !== null &&
		value.settledOverride !== "settled" &&
		value.settledOverride !== "active"
	) {
		return false;
	}
	if (!isRequiredNullableTimestamp(value, "settledAt")) return false;
	if (!isOptionalNullableTimestamp(value, "latestUserMessageAt")) return false;
	if (!isOptionalNullableTimestamp(value, "snoozedAt")) return false;
	if (!isOptionalNullableTimestamp(value, "snoozedUntil")) return false;
	if (typeof value.hasPendingApprovals !== "boolean") return false;
	if (typeof value.hasPendingUserInput !== "boolean") return false;
	if (typeof value.hasActionableProposedPlan !== "boolean") return false;
	if (
		value.backgroundLiveness !== undefined &&
		value.backgroundLiveness !== null &&
		value.backgroundLiveness !== "working" &&
		value.backgroundLiveness !== "monitoring"
	) {
		return false;
	}
	return isLatestTurn(value.latestTurn) && isThreadSession(value.session);
}

function isT3ShellSnapshot(value: unknown): value is T3ShellSnapshot {
	if (!isRecord(value)) return false;
	if (!Number.isSafeInteger(value.snapshotSequence) || Number(value.snapshotSequence) < 0) return false;
	if (
		!isTimestamp(value.updatedAt) ||
		!Array.isArray(value.threads) ||
		value.threads.length > MAX_THREADS_PER_SNAPSHOT
	) {
		return false;
	}
	const threadIds = new Set<string>();
	for (const thread of value.threads) {
		if (!isT3ThreadShell(thread)) return false;
		if (threadIds.has(thread.id)) return false;
		threadIds.add(thread.id);
	}
	return true;
}

export function decodeStoredShellValue(
	rawValue: Uint8Array,
	budget: T3CacheAllocationBudget = createT3CacheAllocationBudget(),
): StoredShellValue {
	return decodeStoredShellWireData(objectStoreWireData(rawValue, budget), budget);
}

function decodeStoredShellWireData(wireData: Uint8Array, budget: T3CacheAllocationBudget): StoredShellValue {
	const decoded = unwrapBlinkWireData(wireData, budget);
	const decodedBytes = Buffer.byteLength(decoded);
	if (decodedBytes > MAX_SHELL_JSON_BYTES) return fail("unsupported");
	reserveAllocation(budget, decodedBytes * JSON_PARSE_ALLOCATION_MULTIPLIER);
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoded);
	} catch (cause) {
		return fail("corrupt", cause);
	}
	if (typeof parsed !== "object" || parsed === null) return fail("corrupt");
	const stored = parsed as Record<string, unknown>;
	if (
		stored.schemaVersion !== 1 ||
		typeof stored.environmentId !== "string" ||
		stored.environmentId.length === 0 ||
		!isT3ShellSnapshot(stored.snapshot)
	) {
		return fail("corrupt");
	}
	return {
		environmentId: stored.environmentId,
		schemaVersion: 1,
		snapshot: stored.snapshot,
	};
}

function decodeExternalStoredShellWireData(
	wireData: Uint8Array,
	budget: T3CacheAllocationBudget,
): StoredShellValue {
	try {
		return decodeStoredShellWireData(wireData, budget);
	} catch (cause) {
		if (cause instanceof T3CacheError && cause.code === "inconsistent") return fail("corrupt", cause);
		throw cause;
	}
}

function latestShellDataRecords(
	records: readonly LevelDbRecord[],
	budget: T3CacheAllocationBudget,
): Map<string, LevelDbRecord> {
	const latest = new Map<string, LevelDbRecord>();
	for (const record of records) {
		// This guard is deliberately before decodeStoredShellValue. Values from
		// catalog/keys, blob metadata, thread, server-config, and vcs-refs are never interpreted.
		if (!isShellObjectStoreKey(record.key)) continue;
		const environmentId = decodeIndexedDbStringKey(record.key, budget);
		const previous = latest.get(environmentId);
		if (previous === undefined || record.sequence > previous.sequence) {
			latest.set(environmentId, record);
		}
	}
	return latest;
}

function latestShellRecords(
	records: readonly LevelDbRecord[],
	budget: T3CacheAllocationBudget,
): LatestShellRecords {
	const latest: LatestShellRecords = { blobEntries: new Map(), data: new Map() };
	for (const [environmentId, record] of latestShellDataRecords(records, budget)) {
		latest.data.set(environmentId, {
			keyIdentity: shellUserKeyIdentity(record.key, budget),
			record,
		});
	}
	for (const record of records) {
		if (shellRecordKind(record.key) !== "blob-entry") continue;
		const keyIdentity = shellUserKeyIdentity(record.key, budget);
		const previous = latest.blobEntries.get(keyIdentity);
		if (previous === undefined || record.sequence > previous.sequence) {
			latest.blobEntries.set(keyIdentity, record);
		}
	}
	return latest;
}

function appendDecodedShell(
	shells: CachedT3Shell[],
	expectedEnvironmentId: string,
	stored: StoredShellValue,
): void {
	if (stored.environmentId !== expectedEnvironmentId) fail("corrupt");
	shells.push({ environmentId: stored.environmentId, snapshot: stored.snapshot });
}

function sortShells(shells: CachedT3Shell[]): CachedT3Shell[] {
	return shells.sort((left, right) => left.environmentId.localeCompare(right.environmentId));
}

export function collectCachedT3Shells(
	records: readonly LevelDbRecord[],
	budget: T3CacheAllocationBudget = createT3CacheAllocationBudget(),
): CachedT3Shell[] {
	const latestByEnvironment = latestShellDataRecords(records, budget);
	const shells: CachedT3Shell[] = [];
	for (const [expectedEnvironmentId, record] of latestByEnvironment) {
		if (record.recordType === 0) continue;
		const stored = decodeStoredShellValue(record.value, budget);
		appendDecodedShell(shells, expectedEnvironmentId, stored);
	}
	return sortShells(shells);
}

function isDatabaseFilename(name: string): boolean {
	return /^\d+\.(?:ldb|log|sst)$/.test(name);
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

async function scanDirectoryNames(
	directory: string,
	maxEntries: number,
	maxMatches: number,
	matches: (entry: DirectoryEntry) => boolean,
	openDirectory: OpenDirectory,
): Promise<string[]> {
	let handle: DirectoryHandle;
	try {
		handle = await openDirectory(directory);
	} catch (cause) {
		return fail("unavailable", cause);
	}

	const names: string[] = [];
	let entriesRead = 0;
	let scanFailure: { cause: unknown } | undefined;
	try {
		while (true) {
			const entry = await handle.read();
			if (entry === null) break;
			if (entriesRead === maxEntries) return fail("unsupported");
			entriesRead += 1;
			if (!matches(entry)) continue;
			if (names.length === maxMatches) return fail("unsupported");
			names.push(entry.name);
		}
	} catch (cause) {
		scanFailure = { cause };
	}
	try {
		await handle.close();
	} catch (cause) {
		scanFailure ??= { cause };
	}
	if (scanFailure !== undefined) {
		if (scanFailure.cause instanceof T3CacheError) throw scanFailure.cause;
		return fail("unavailable", scanFailure.cause);
	}
	return names;
}

export async function databaseFilenames(
	directory: string,
	openDirectory: OpenDirectory = opendir,
): Promise<string[]> {
	return (
		await scanDirectoryNames(
			directory,
			MAX_DATABASE_DIRECTORY_ENTRIES,
			MAX_DATABASE_FILES,
			(entry) => isDatabaseFilename(entry.name),
			openDirectory,
		)
	).sort();
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}

async function readOnce(
	directory: string,
	budget: T3CacheAllocationBudget = createT3CacheAllocationBudget(),
): Promise<CachedT3Shell[]> {
	const before = await databaseFilenames(directory);
	const records: LevelDbRecord[] = [];
	const inputBudget: ReadInputBudget = { remainingBytes: MAX_DATABASE_TOTAL_BYTES };
	try {
		for (const name of before) {
			const contents = await readBoundedFile(resolve(directory, name), inputBudget.remainingBytes, budget);
			inputBudget.remainingBytes -= contents.length;
			appendRecords(
				records,
				name.endsWith(".log")
					? parseLevelDbLog(contents, isShellCacheKey, budget)
					: parseLevelDbTable(contents, isShellCacheKey, budget),
			);
		}
		const shells = await collectCachedT3ShellsWithBlobs(records, directory, inputBudget, budget);
		const after = await databaseFilenames(directory);
		if (!sameNames(before, after)) return fail("inconsistent");
		return shells;
	} catch (cause) {
		if (isNodeError(cause) && cause.code === "ENOENT") return fail("inconsistent", cause);
		throw cause;
	}
}

function externalBlobPath(directory: string, blobNumber: number): string {
	const databaseName = basename(directory);
	if (!databaseName.endsWith(INDEXED_DB_LEVELDB_SUFFIX)) return fail("unsupported");
	const blobDirectory = resolve(
		dirname(directory),
		`${databaseName.slice(0, -INDEXED_DB_LEVELDB_SUFFIX.length)}.indexeddb.blob`,
	);
	const highByte = Number((BigInt(blobNumber) & 0xff00n) >> 8n);
	return resolve(
		blobDirectory,
		DATABASE_ID.toString(16),
		highByte.toString(16).padStart(2, "0"),
		blobNumber.toString(16),
	);
}

async function readExternalBlob(
	path: string,
	expectedSize: number,
	inputBudget: ReadInputBudget,
	budget: T3CacheAllocationBudget,
): Promise<Buffer> {
	if (expectedSize > MAX_STORED_SHELL_PAYLOAD_BYTES || expectedSize > inputBudget.remainingBytes) {
		return fail("unsupported");
	}
	const { handle, metadata } = await openStableRegularFile(path);
	try {
		if (metadata.size !== BigInt(expectedSize)) return fail("inconsistent");
		reserveAllocation(budget, expectedSize);
		const contents = Buffer.allocUnsafe(expectedSize);
		let offset = 0;
		while (offset < expectedSize) {
			const { bytesRead } = await handle.read(contents, offset, expectedSize - offset, offset);
			if (bytesRead === 0) return fail("inconsistent");
			offset += bytesRead;
		}
		const extraByte = Buffer.allocUnsafe(1);
		if ((await handle.read(extraByte, 0, 1, expectedSize)).bytesRead !== 0) {
			return fail("inconsistent");
		}
		await assertFileUnchanged(handle, metadata);
		inputBudget.remainingBytes -= expectedSize;
		return contents;
	} finally {
		await handle.close();
	}
}

async function collectCachedT3ShellsWithBlobs(
	records: readonly LevelDbRecord[],
	directory: string,
	inputBudget: ReadInputBudget,
	budget: T3CacheAllocationBudget,
): Promise<CachedT3Shell[]> {
	const latest = latestShellRecords(records, budget);
	const shells: CachedT3Shell[] = [];
	for (const [expectedEnvironmentId, { keyIdentity, record }] of latest.data) {
		if (record.recordType === 0) continue;
		const external = externalShellValue(record.value, budget);
		if (external === undefined) {
			appendDecodedShell(shells, expectedEnvironmentId, decodeStoredShellValue(record.value, budget));
			continue;
		}

		const metadataRecord = latest.blobEntries.get(keyIdentity);
		if (
			metadataRecord === undefined ||
			metadataRecord.recordType === 0 ||
			metadataRecord.sequence <= record.sequence
		) {
			return fail("inconsistent");
		}
		const wrapperBlob = parseExternalWrapperBlob(metadataRecord.value, external.blobIndex, budget);
		if (wrapperBlob.size !== external.blobSize) return fail("corrupt");
		const wireData = await readExternalBlob(
			externalBlobPath(directory, wrapperBlob.blobNumber),
			wrapperBlob.size,
			inputBudget,
			budget,
		);
		appendDecodedShell(shells, expectedEnvironmentId, decodeExternalStoredShellWireData(wireData, budget));
	}
	return sortShells(shells);
}

async function readBoundedFile(
	path: string,
	remainingBytes: number,
	budget: T3CacheAllocationBudget,
): Promise<Buffer> {
	const { handle, metadata } = await openStableRegularFile(path);
	try {
		const permittedBytes = BigInt(Math.max(0, Math.min(MAX_DATABASE_FILE_BYTES, remainingBytes)));
		if (metadata.size > permittedBytes) return fail("unsupported");
		const size = Number(metadata.size);
		reserveAllocation(budget, size);
		const contents = Buffer.allocUnsafe(size);
		let offset = 0;
		while (offset < size) {
			const { bytesRead } = await handle.read(contents, offset, size - offset, offset);
			if (bytesRead === 0) return fail("inconsistent");
			offset += bytesRead;
		}
		const extraByte = Buffer.allocUnsafe(1);
		if ((await handle.read(extraByte, 0, 1, size)).bytesRead !== 0) return fail("inconsistent");
		await assertFileUnchanged(handle, metadata);
		return contents;
	} finally {
		await handle.close();
	}
}

async function openStableRegularFile(path: string): Promise<{ handle: FileHandle; metadata: BigIntStats }> {
	const before = await lstat(path, { bigint: true });
	if (!before.isFile()) return fail("unsupported");
	let handle: FileHandle;
	try {
		handle = await open(path, READ_ONLY_FILE_FLAGS);
	} catch (cause) {
		if (isNodeError(cause) && (cause.code === "ENOENT" || cause.code === "ELOOP")) {
			return fail("inconsistent", cause);
		}
		throw cause;
	}
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || !sameFileIdentity(before, opened)) return fail("inconsistent");
		return { handle, metadata: opened };
	} catch (cause) {
		await handle.close();
		throw cause;
	}
}

async function assertFileUnchanged(handle: FileHandle, before: BigIntStats): Promise<void> {
	const after = await handle.stat({ bigint: true });
	if (
		!after.isFile() ||
		!sameFileIdentity(before, after) ||
		after.size !== before.size ||
		after.mtimeNs !== before.mtimeNs ||
		after.ctimeNs !== before.ctimeNs
	) {
		return fail("inconsistent");
	}
}

export function sameFileIdentity(
	left: Pick<BigIntStats, "dev" | "ino">,
	right: Pick<BigIntStats, "dev" | "ino">,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (left.ino !== right.ino) return false;
	if (platform === "win32") return left.ino !== 0n;
	return left.dev === right.dev;
}

async function readDirectoryWithRetries(
	directory: string,
	budget: T3CacheAllocationBudget = createT3CacheAllocationBudget(),
): Promise<CachedT3Shell[]> {
	let lastError: unknown;
	for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
		const checkpoint = { ...budget };
		try {
			return await readOnce(directory, budget);
		} catch (cause) {
			lastError = cause;
			if (!(cause instanceof T3CacheError) || cause.code !== "inconsistent") throw cause;
			Object.assign(budget, checkpoint);
		}
	}
	if (lastError instanceof T3CacheError) throw lastError;
	return fail("inconsistent", lastError);
}

export async function discoverT3CacheDirectories(
	options: Pick<
		ReadT3ShellCacheOptions,
		"configDirectory" | "environment" | "homeDirectory" | "platform"
	> = {},
	openDirectory: OpenDirectory = opendir,
): Promise<string[]> {
	const environment = options.environment ?? process.env;
	const configDirectory = resolve(
		options.configDirectory ??
			defaultConfigDirectory(
				options.platform ?? process.platform,
				environment,
				options.homeDirectory ?? homedir(),
			),
	);
	const profiles = await scanDirectoryNames(
		configDirectory,
		MAX_CONFIG_DIRECTORY_ENTRIES,
		MAX_T3_PROFILES,
		(entry) => T3_USER_DATA_DIRECTORY.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()),
		openDirectory,
	);
	return profiles
		.map((name) => resolve(configDirectory, name, ...T3_INDEXED_DB_DIRECTORY))
		.sort((left, right) => left.localeCompare(right));
}

function matchingShells(profile: CachedT3Profile, environmentId: string | undefined): CachedT3Shell[] {
	return environmentId === undefined
		? profile.shells
		: profile.shells.filter((shell) => shell.environmentId === environmentId);
}

function profileFreshness(profile: CachedT3Profile, environmentId: string | undefined): number {
	return matchingShells(profile, environmentId).reduce(
		(latest, shell) => Math.max(latest, Date.parse(shell.snapshot.updatedAt)),
		Number.NEGATIVE_INFINITY,
	);
}

function profileSequence(profile: CachedT3Profile, environmentId: string | undefined): number {
	return matchingShells(profile, environmentId).reduce(
		(latest, shell) => Math.max(latest, shell.snapshot.snapshotSequence),
		-1,
	);
}

function selectProfile(
	profiles: readonly CachedT3Profile[],
	environmentId: string | undefined,
): CachedT3Profile {
	const matchingProfiles =
		environmentId === undefined
			? profiles
			: profiles.filter((profile) => profile.shells.some((shell) => shell.environmentId === environmentId));
	if (matchingProfiles.length === 0) return fail("unavailable");
	return [...matchingProfiles].sort((left, right) => {
		const freshness = profileFreshness(right, environmentId) - profileFreshness(left, environmentId);
		if (freshness !== 0) return freshness;
		const sequence = profileSequence(right, environmentId) - profileSequence(left, environmentId);
		if (sequence !== 0) return sequence;
		return left.directory.localeCompare(right.directory);
	})[0] as CachedT3Profile;
}

export async function readT3ShellCache(options: ReadT3ShellCacheOptions = {}): Promise<CachedT3Shell[]> {
	const environment = options.environment ?? process.env;
	const environmentDirectory = environment.T3CODE_CACHE_DIR?.trim();
	const explicitDirectory = options.directory?.trim() || environmentDirectory || undefined;
	const budget = createT3CacheAllocationBudget();
	if (explicitDirectory !== undefined) {
		const shells = await readDirectoryWithRetries(resolve(explicitDirectory), budget);
		const environmentId = options.environmentId?.trim() || undefined;
		if (environmentId !== undefined && !shells.some((shell) => shell.environmentId === environmentId)) {
			return fail("unavailable");
		}
		return shells;
	}

	const directories = await discoverT3CacheDirectories(options);
	if (directories.length === 0) return fail("unavailable");
	const profiles: CachedT3Profile[] = [];
	let lastInvalidProfileError: unknown;
	for (const directory of directories) {
		try {
			profiles.push({ directory, shells: await readDirectoryWithRetries(directory, budget) });
		} catch (cause) {
			if (!(cause instanceof T3CacheError) || cause.code !== "unavailable") {
				lastInvalidProfileError = cause;
			}
		}
	}
	if (profiles.length === 0) {
		if (lastInvalidProfileError instanceof T3CacheError) throw lastInvalidProfileError;
		return fail("unavailable", lastInvalidProfileError);
	}

	const environmentId = options.environmentId?.trim() || undefined;
	return selectProfile(profiles, environmentId).shells;
}
