import { appendFile, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_PATH, ERROR_LOG_PATH, LOCK_PATH, STATS_DIR } from "./config.js";
import { getBucketId, getModelIdentity } from "./identity.js";
import { addSample, restoreDigest, serializeDigest } from "./digest.js";
import { dayKey, summarizeDays } from "./metrics.js";
import { DATA_SCHEMA_VERSION, type ModelLike, type Observation, type ResultCategory, type StatsBucket, type StatsData, type StatsSummary } from "./types.js";

const MAX_LOG_BYTES = 1_000_000;
const RETENTION_DAYS = 30;
const RECENT_RESULTS = 20;
const MAX_CORRUPT_BACKUPS = 5;
const RESULT_CATEGORIES = new Set<ResultCategory>(["success", "network", "timeout", "rate_limit", "server_error", "authentication", "permission", "model_not_found", "stream_error", "malformed_response", "request_rejected", "cancelled", "unknown"]);

async function pruneCorruptBackups(): Promise<void> {
	const files = (await readdir(STATS_DIR)).filter((name) => /^data\.json\.corrupt-\d+$/.test(name)).sort((a, b) => Number(b.slice("data.json.corrupt-".length)) - Number(a.slice("data.json.corrupt-".length)));
	await Promise.all(files.slice(MAX_CORRUPT_BACKUPS).map((name) => rm(join(STATS_DIR, name), { force: true })));
}

export async function logExtensionError(error: unknown): Promise<void> {
	try {
		await mkdir(STATS_DIR, { recursive: true });
		const line = `[${new Date().toISOString()}] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
		await appendFile(ERROR_LOG_PATH, line, "utf8");
		const content = await readFile(ERROR_LOG_PATH);
		if (content.byteLength > MAX_LOG_BYTES) await writeFile(ERROR_LOG_PATH, content.subarray(-MAX_LOG_BYTES));
	} catch { /* Diagnostics must never interfere with Pi or a provider request. */ }
}

async function writeAtomic(path: string, text: string | Uint8Array): Promise<void> {
	await mkdir(STATS_DIR, { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, text);
	await rename(temporary, path);
}

async function withFileLock<T>(operation: () => Promise<T>): Promise<T> {
	await mkdir(STATS_DIR, { recursive: true });
	const deadline = Date.now() + 10_000;
	while (true) {
		try { await mkdir(LOCK_PATH); break; }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if ((code !== "EEXIST" && code !== "EACCES" && code !== "EPERM") || Date.now() >= deadline) throw error;
			try { if (Date.now() - (await stat(LOCK_PATH)).mtimeMs > 30_000) await rm(LOCK_PATH, { recursive: true, force: true }); } catch { /* Lock may disappear during cleanup. */ }
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	const heartbeat = setInterval(() => { void utimes(LOCK_PATH, new Date(), new Date()).catch(() => undefined); }, 5_000);
	try { return await operation(); }
	finally { clearInterval(heartbeat); await rm(LOCK_PATH, { recursive: true, force: true }).catch(() => undefined); }
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function emptyBucket(identity: StatsBucket["identity"]): StatsBucket { return { identity, recent: { lastResults: "", consecutiveFailures: 0 }, days: {} }; }

function addObservation(bucket: StatsBucket, observation: Observation): void {
	const day = bucket.days[dayKey(observation.timestamp)] ??= { total: 0, byResult: {}, firstByteDigest: { count: 0, centroids: [] } };
	day.total++;
	day.byResult[observation.result] = (day.byResult[observation.result] ?? 0) + 1;
	if (observation.firstByteMs !== undefined) day.firstByteDigest = serializeDigest(addSample(day.firstByteDigest, observation.firstByteMs));
	if (observation.result === "success" && observation.outputTokens !== undefined && observation.generationMs !== undefined && observation.outputTokens > 0 && observation.generationMs > 0) {
		day.outputTokens = (day.outputTokens ?? 0) + observation.outputTokens;
		day.generationMs = (day.generationMs ?? 0) + observation.generationMs;
	}
	const recent = bucket.recent;
	const marker = observation.result === "success" ? "s" : observation.result === "cancelled" ? "c" : observation.result === "request_rejected" ? "r" : "f";
	recent.lastResults = (recent.lastResults + marker).slice(-RECENT_RESULTS);
	if (observation.result === "success") {
		recent.consecutiveFailures = 0;
		recent.lastSuccessAt = observation.timestamp;
	} else if (observation.result !== "cancelled" && observation.result !== "request_rejected") {
		recent.consecutiveFailures++;
		recent.lastFailureAt = observation.timestamp;
	}
}

function validBucket(value: unknown, key: string): value is StatsBucket {
	if (!isObject(value) || !isObject(value.identity) || typeof value.identity.provider !== "string" || typeof value.identity.modelId !== "string" || typeof value.identity.configFingerprint !== "string" || !isObject(value.recent) || typeof value.recent.lastResults !== "string" || value.recent.lastResults.length > RECENT_RESULTS || !/^[scrf]*$/.test(value.recent.lastResults) || !Number.isSafeInteger(value.recent.consecutiveFailures) || (value.recent.consecutiveFailures as number) < 0 || !isObject(value.days)) return false;
	if (getBucketId(value.identity as unknown as StatsBucket["identity"]) !== key) return false;
	if ((value.recent.lastSuccessAt !== undefined && (typeof value.recent.lastSuccessAt !== "number" || !Number.isFinite(value.recent.lastSuccessAt))) || (value.recent.lastFailureAt !== undefined && (typeof value.recent.lastFailureAt !== "number" || !Number.isFinite(value.recent.lastFailureAt)))) return false;
	for (const day of Object.values(value.days)) {
		if (!isObject(day) || !isObject(day.byResult) || typeof day.total !== "number") return false;
		const resultTotal = (Object.values(day.byResult) as unknown[]).reduce<number>((sum, count) => sum + (typeof count === "number" ? count : 0), 0);
		if (resultTotal !== day.total) return false;
		if (day.outputTokens !== undefined && day.generationMs === undefined) return false;
		if (day.generationMs !== undefined && day.outputTokens === undefined) return false;
		if ((day.outputTokens !== undefined && (typeof day.outputTokens !== "number" || !Number.isFinite(day.outputTokens) || day.outputTokens < 0)) || (day.generationMs !== undefined && (typeof day.generationMs !== "number" || !Number.isFinite(day.generationMs) || day.generationMs < 0))) return false;
	}
	return Object.entries(value.days).every(([key, day]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && isObject(day) && typeof day.total === "number" && Number.isInteger(day.total) && day.total >= 0 && isObject(day.byResult) && Object.entries(day.byResult).every(([result, count]) => RESULT_CATEGORIES.has(result as ResultCategory) && typeof count === "number" && Number.isInteger(count) && count >= 0) && (() => { try { restoreDigest(day.firstByteDigest); return true; } catch { return false; } })() && (day.outputTokens === undefined || (typeof day.outputTokens === "number" && Number.isFinite(day.outputTokens) && day.outputTokens >= 0)) && (day.generationMs === undefined || (typeof day.generationMs === "number" && Number.isFinite(day.generationMs) && day.generationMs >= 0)));
}

function migrateV1(parsed: Record<string, unknown>): StatsData | undefined {
	if (!isObject(parsed.buckets)) return undefined;
	const data: StatsData = { schemaVersion: DATA_SCHEMA_VERSION, buckets: {} };
	for (const raw of Object.values(parsed.buckets)) {
		if (!isObject(raw) || !isObject(raw.identity) || !Array.isArray(raw.observations)) return undefined;
		const rawIdentity = raw.identity;
		if (typeof rawIdentity.provider !== "string" || typeof rawIdentity.modelId !== "string" || typeof rawIdentity.configFingerprint !== "string") return undefined;
		const identity: StatsBucket["identity"] = { provider: rawIdentity.provider, modelId: rawIdentity.modelId, configFingerprint: rawIdentity.configFingerprint };
		const bucket = emptyBucket(identity);
		let valid = true;
		for (const item of raw.observations) {
			if (!isObject(item) || typeof item.timestamp !== "number" || !Number.isFinite(item.timestamp) || typeof item.result !== "string" || !RESULT_CATEGORIES.has(item.result as ResultCategory) || (item.firstByteMs !== undefined && (typeof item.firstByteMs !== "number" || !Number.isFinite(item.firstByteMs) || item.firstByteMs < 0))) { valid = false; break; }
			const observation: Observation = { timestamp: item.timestamp, result: item.result as ResultCategory };
			if (typeof item.firstByteMs === "number" && Number.isFinite(item.firstByteMs) && item.firstByteMs >= 0) observation.firstByteMs = item.firstByteMs;
			addObservation(bucket, observation);
		}
		if (!valid) return undefined;
		data.buckets[getBucketId(identity)] = bucket;
	}
	return data;
}

function migrateDailyData(rawBuckets: Record<string, unknown>, version: number): StatsData | undefined {
	const migrated: StatsData = { schemaVersion: DATA_SCHEMA_VERSION, buckets: {} };
	for (const [id, raw] of Object.entries(rawBuckets)) {
		if (!validLegacyBucket(raw, version)) return undefined;
		const bucket = raw as unknown as StatsBucket;
		for (const day of Object.values(bucket.days)) {
			if (version === 2 && day.outputTokens === undefined) delete day.outputTokens;
			const values = (day as unknown as { firstByteMs: number[] }).firstByteMs;
			let digest = { count: 0, centroids: [] as { mean: number; count: number }[] };
			for (const value of values) digest = addSample(digest, value);
			(day as unknown as { firstByteDigest: typeof digest }).firstByteDigest = digest;
			delete (day as unknown as { firstByteMs?: number[] }).firstByteMs;
		}
		migrated.buckets[id] = bucket;
	}
	return migrated;
}

function validLegacyBucket(value: unknown, version: number): boolean {
	if (!isObject(value) || !isObject(value.identity) || !isObject(value.recent) || !isObject(value.days)) return false;
	return Object.entries(value.days).every(([key, day]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && isObject(day) && typeof day.total === "number" && Number.isInteger(day.total) && day.total >= 0 && isObject(day.byResult) && Object.entries(day.byResult).every(([result, count]) => RESULT_CATEGORIES.has(result as ResultCategory) && typeof count === "number" && Number.isInteger(count) && count >= 0) && Array.isArray(day.firstByteMs) && day.firstByteMs.every((ms) => typeof ms === "number" && Number.isFinite(ms) && ms >= 0) && (version === 2 || day.outputTokens === undefined || (typeof day.outputTokens === "number" && Number.isFinite(day.outputTokens) && day.outputTokens >= 0)) && (version === 2 || day.generationMs === undefined || (typeof day.generationMs === "number" && Number.isFinite(day.generationMs) && day.generationMs >= 0)));
}

async function readData(): Promise<StatsData> {
	try {
		const parsed: unknown = JSON.parse(await readFile(DATA_PATH, "utf8"));
		if (!isObject(parsed)) throw new Error("invalid statistics data schema");
		if (parsed.schemaVersion === 1) {
			const migrated = migrateV1(parsed);
			if (!migrated) throw new Error("invalid statistics data schema");
			return migrated;
		}
		if ((parsed.schemaVersion === 2 || parsed.schemaVersion === 3) && isObject(parsed.buckets)) {
			const migrated = migrateDailyData(parsed.buckets, parsed.schemaVersion);
			if (!migrated) throw new Error("invalid statistics data schema");
			return migrated;
		}
		if (parsed.schemaVersion !== DATA_SCHEMA_VERSION || !isObject(parsed.buckets) || !Object.entries(parsed.buckets).every(([key, value]) => validBucket(value, key))) throw new Error("invalid statistics data schema");
		return parsed as unknown as StatsData;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: DATA_SCHEMA_VERSION, buckets: {} };
		try {
			await mkdir(STATS_DIR, { recursive: true });
			await rename(DATA_PATH, `${DATA_PATH}.corrupt-${Date.now()}`);
			await pruneCorruptBackups();
		} catch { /* Keep original error. */ }
		await logExtensionError(`statistics data recovered: ${error instanceof Error ? error.message : String(error)}`);
		return { schemaVersion: DATA_SCHEMA_VERSION, buckets: {} };
	}
}

function pruneDays(bucket: StatsBucket, now: number): void {
	const cutoff = new Date(`${dayKey(now)}T00:00:00.000Z`);
	cutoff.setUTCDate(cutoff.getUTCDate() - (RETENTION_DAYS - 1));
	const minKey = dayKey(cutoff.getTime());
	for (const key of Object.keys(bucket.days)) if (key < minKey) delete bucket.days[key];
}

export class StatsStore {
	private data: StatsData;
	private writeQueue: Promise<void> = Promise.resolve();
	private constructor(data: StatsData) { this.data = data; }
	static async create(): Promise<StatsStore> {
		const data = await withFileLock(async () => {
			const latest = await readData();
			if (latest.schemaVersion === DATA_SCHEMA_VERSION) await writeAtomic(DATA_PATH, JSON.stringify(latest, null, "\t") + "\n");
			return latest;
		}).catch(async (error) => {
			await logExtensionError(error);
			return { schemaVersion: DATA_SCHEMA_VERSION, buckets: {} };
		});
		return new StatsStore(data);
	}
	getSummary(model: ModelLike, now = Date.now()): StatsSummary {
		const bucket = this.data.buckets[getBucketId(getModelIdentity(model))];
		if (!bucket && !model.baseUrl) {
			const candidates = Object.values(this.data.buckets).filter((item) => item.identity.provider === model.provider && item.identity.modelId === model.id);
			if (candidates.length === 1) return summarizeDays(candidates[0]!.days, now);
		}
		return summarizeDays(bucket?.days ?? {}, now);
	}
	record(model: ModelLike, observation: Observation): void {
		this.writeQueue = this.writeQueue.then(async () => {
			try {
				await withFileLock(async () => {
					const latest = await readData();
					const identity = getModelIdentity(model);
					const id = getBucketId(identity);
					const bucket = latest.buckets[id] ?? emptyBucket(identity);
					const next = { ...observation };
					addObservation(bucket, next);
					pruneDays(bucket, Date.now());
					latest.buckets[id] = bucket;
					await writeAtomic(DATA_PATH, JSON.stringify(latest, null, "\t") + "\n");
					this.data = latest;
				});
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			} catch (error) { void logExtensionError(error); }
		}).catch((error) => void logExtensionError(error));
	}
}
