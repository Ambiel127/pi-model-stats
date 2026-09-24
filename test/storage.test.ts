import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "./test/.test-agent" }));

import { DATA_PATH, ERROR_LOG_PATH, LOCK_PATH, STATS_DIR } from "../src/config.js";
import { StatsStore } from "../src/storage.js";
import type { ModelLike } from "../src/types.js";

const model: ModelLike = { provider: "storage-provider", id: "storage-model", api: "openai-completions", baseUrl: "https://storage.test/v1" };

async function waitForFile(path: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		try { await readFile(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitForObservationCount(count: number, timeoutMs = 2_000): Promise<any> {
	for (let i = 0; i < timeoutMs / 10; i++) {
		try {
			const value = JSON.parse(await readFile(DATA_PATH, "utf8"));
			const bucket = Object.values(value.buckets)[0] as { days: Record<string, { total: number }> } | undefined;
			if (bucket && Object.values(bucket.days).reduce((sum, day) => sum + day.total, 0) >= count) return value;
		} catch { /* Wait for queued writes. */ }
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${count} observations`);
}

const STORAGE_TEST_DIR = "./test/.test-agent/model-stats";

async function resetStorage(): Promise<void> {
	await rm(STORAGE_TEST_DIR, { recursive: true, force: true });
	await mkdir(STORAGE_TEST_DIR, { recursive: true });
}

describe("storage runtime boundary", () => {
	beforeEach(resetStorage);
	afterAll(async () => {
		for (let attempt = 0; attempt < 20; attempt++) {
			try { await rm(STORAGE_TEST_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return; }
			catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
		}
	});

	it("treats a missing data file as normal initialization", async () => {
		await StatsStore.create();
		expect((await readdir(STATS_DIR)).includes("error.log")).toBe(false);
	});

	it("waits for an existing writer lock before reading or rewriting data", async () => {
		const original = JSON.stringify({ schemaVersion: 4, buckets: {} });
		await writeFile(DATA_PATH, original);
		await mkdir(LOCK_PATH);
		let settled = false;
		const creating = StatsStore.create().finally(() => { settled = true; });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(settled).toBe(false);
		expect(await readFile(DATA_PATH, "utf8")).toBe(original);
		await rm(LOCK_PATH, { recursive: true, force: true });
		await creating;
		expect(JSON.parse(await readFile(DATA_PATH, "utf8")).schemaVersion).toBe(4);
	});

	it("recovers a lock directory whose heartbeat has expired", async () => {
		await mkdir(LOCK_PATH);
		const expired = new Date(Date.now() - 60_000);
		const { utimes } = await import("node:fs/promises");
		await utimes(LOCK_PATH, expired, expired);
		const store = await StatsStore.create();
		expect(store.getSummary(model).weekAttempts).toBe(0);
		expect(await readdir(STATS_DIR)).not.toContain(".lock");
	});

	it("serializes concurrent initialization without replacing newer data with an empty snapshot", async () => {
		const stores = await Promise.all(Array.from({ length: 6 }, () => StatsStore.create()));
		const writers = stores.slice(0, 2);
		writers[0]!.record(model, { timestamp: Date.now(), result: "success" });
		writers[1]!.record(model, { timestamp: Date.now() + 1, result: "success" });
		const persisted = await waitForObservationCount(2);
		expect(Object.values(persisted.buckets)).toHaveLength(1);
	}, 15_000);

	it("migrates valid v1 observations into daily digest aggregates", async () => {
		const timestamp = Date.now();
		await writeFile(DATA_PATH, JSON.stringify({ schemaVersion: 1, buckets: { legacy: { identity: { provider: model.provider, modelId: model.id, configFingerprint: "legacy" }, observations: [{ timestamp, result: "success", firstByteMs: 120 }, { timestamp: timestamp + 1, result: "server_error" }] } } }));
		const store = await StatsStore.create();
		const migrated = JSON.parse(await readFile(DATA_PATH, "utf8"));
		expect(migrated.schemaVersion).toBe(4);
		expect(Object.values(migrated.buckets)[0]).not.toHaveProperty("observations");
		expect(store.getSummary({ ...model, baseUrl: "" }).weekSuccesses).toBe(1);
		expect(store.getSummary({ ...model, baseUrl: "" }).firstByteP50).toBe(120);
	});

	it("migrates v2 and v3 daily raw samples into digests", async () => {
		const day = new Date().toISOString().slice(0, 10);
		for (const version of [2, 3]) {
			await writeFile(DATA_PATH, JSON.stringify({ schemaVersion: version, buckets: { legacy: { identity: { provider: model.provider, modelId: model.id, configFingerprint: "legacy" }, recent: { lastResults: "s", consecutiveFailures: 0 }, days: { [day]: { total: 2, byResult: { success: 2 }, firstByteMs: [100, 200], ...(version === 3 ? { outputTokens: 10, generationMs: 1000 } : {}) } } } } }));
			const store = await StatsStore.create();
			const migrated = JSON.parse(await readFile(DATA_PATH, "utf8"));
			expect(migrated.schemaVersion).toBe(4);
			const daily = Object.values((Object.values(migrated.buckets)[0] as any).days)[0] as any;
			expect(daily).not.toHaveProperty("firstByteMs");
			expect(daily.firstByteDigest.count).toBe(2);
			expect(store.getSummary({ ...model, baseUrl: "" }).firstByteP50).toBe(100);
			expect(store.getSummary({ ...model, baseUrl: "" }).weekTps).toBe(version === 3 ? 10 : undefined);
		}
	});

	it("rejects persisted daily totals that disagree with result counts", async () => {
		const day = new Date().toISOString().slice(0, 10);
		await writeFile(DATA_PATH, JSON.stringify({ schemaVersion: 4, buckets: { broken: { identity: { provider: model.provider, modelId: model.id, configFingerprint: "x" }, recent: { lastResults: "", consecutiveFailures: 0 }, days: { [day]: { total: 9, byResult: { success: 1 }, firstByteDigest: { count: 0, centroids: [] } } } } } }));
		const store = await StatsStore.create();
		expect(store.getSummary(model).weekAttempts).toBe(0);
		expect((await readdir(STATS_DIR)).some((file) => file.startsWith("data.json.corrupt-"))).toBe(true);
	});

	it.each([
		["bucket identity does not match its key", (data: any) => { data.buckets.invalid = structuredClone(data.buckets[Object.keys(data.buckets)[0]!]); }],
		["recent result marker is invalid", (data: any) => { data.buckets[Object.keys(data.buckets)[0]!].recent.lastResults = "?"; }],
		["output-token totals are invalid", (data: any) => { const day = data.buckets[Object.keys(data.buckets)[0]!].days[Object.keys(data.buckets[Object.keys(data.buckets)[0]!].days)[0]!]; day.outputTokens = -1; }],
	])("rejects persisted data when %s", async (_case, corrupt) => {
		await resetStorage();
		const store = await StatsStore.create();
		store.record(model, { timestamp: Date.now(), result: "success" });
		await new Promise((resolve) => setTimeout(resolve, 30));
		const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
		corrupt(data);
		await writeFile(DATA_PATH, JSON.stringify(data));
		await StatsStore.create();
		expect((await readdir(STATS_DIR)).some((name) => name.startsWith("data.json.corrupt-"))).toBe(true);
	});

	it("backs up invalid data and continues with an empty valid store", async () => {
		await writeFile(DATA_PATH, JSON.stringify({ schemaVersion: 1, buckets: { broken: { observations: "nope" } } }));
		const store = await StatsStore.create();
		expect(store.getSummary(model).weekAttempts).toBe(0);
		expect((await readdir(STATS_DIR)).some((file) => file.startsWith("data.json.corrupt-"))).toBe(true);
		expect(await readFile(ERROR_LOG_PATH, "utf8")).toContain("invalid statistics data schema");
	});

	it("keeps only the five newest corrupt data backups", async () => {
		for (let i = 0; i < 7; i++) { await writeFile(DATA_PATH, JSON.stringify({ schemaVersion: 999 })); await StatsStore.create(); }
		expect((await readdir(STATS_DIR)).filter((file) => /^data\.json\.corrupt-\d+$/.test(file))).toHaveLength(5);
	});

	it("does not lose observations from concurrent store instances", async () => {
		const first = await StatsStore.create(), second = await StatsStore.create();
		first.record(model, { timestamp: Date.now(), result: "success", firstByteMs: 100, outputTokens: 120, generationMs: 3000 });
		second.record(model, { timestamp: Date.now() + 1, result: "success", firstByteMs: 200, outputTokens: 280, generationMs: 7000 });
		await waitForObservationCount(2);
		expect(Object.values(JSON.parse(await readFile(DATA_PATH, "utf8")).buckets)).toHaveLength(1);
		expect(first.getSummary({ ...model, baseUrl: "" }).weekTps).toBe(40);
	});

	it("preserves all observations under concurrent writes from many stores", async () => {
		const stores = await Promise.all(Array.from({ length: 4 }, () => StatsStore.create()));
		const writesPerStore = 8;
		for (let i = 0; i < writesPerStore; i++) {
			for (const [index, store] of stores.entries()) {
				store.record(model, { timestamp: Date.now() + i * stores.length + index, result: "success", firstByteMs: index + 1, outputTokens: 1, generationMs: 1000 });
			}
		}
		const persisted = await waitForObservationCount(stores.length * writesPerStore, 60_000);
		const bucket = Object.values(persisted.buckets)[0] as { days: Record<string, { total: number; byResult: Record<string, number>; outputTokens: number; generationMs: number }> };
		const days = Object.values(bucket.days);
		expect(days.reduce((sum, day) => sum + day.total, 0)).toBe(stores.length * writesPerStore);
		expect(days.reduce((sum, day) => sum + day.byResult.success, 0)).toBe(stores.length * writesPerStore);
		expect(days.reduce((sum, day) => sum + day.outputTokens, 0)).toBe(stores.length * writesPerStore);
		expect(days.reduce((sum, day) => sum + day.generationMs, 0)).toBe(stores.length * writesPerStore * 1000);
	}, 75_000);

	it("persists a bounded digest instead of raw latency samples", async () => {
		const store = await StatsStore.create();
		const timestamp = Date.now();
		for (let i = 0; i < 20; i++) store.record(model, { timestamp, result: "success", firstByteMs: i < 18 ? 100 + i % 20 : 1000 + i * 10 });
		const persisted = await waitForObservationCount(20);
		const daily = Object.values((Object.values(persisted.buckets)[0] as any).days)[0] as any;
		expect(daily).not.toHaveProperty("firstByteMs");
		expect(daily.firstByteDigest.count).toBe(20);
		expect(daily.firstByteDigest.centroids.length).toBeLessThanOrEqual(300);
		expect(store.getSummary({ ...model, baseUrl: "" }).firstByteP90).toBeGreaterThan(100);
	});

	it("never persists provider error messages", async () => {
		const store = await StatsStore.create();
		store.record(model, { timestamp: Date.now(), result: "server_error" });
		await waitForFile(DATA_PATH);
		expect(await readFile(DATA_PATH, "utf8")).not.toContain("secret");
	});
});
