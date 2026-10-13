import { readFileSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatsStore } from "../src/storage.js";
import type { ModelLike } from "../src/types.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "./test/.rename-agent" }));

// Windows 上 rename 覆盖被占用的目标会瞬时 EPERM（实测：4 个 store 并发写，200 轮丢 20 条观测，
// 错误被 record() 的 catch 吞掉 → 静默丢数据）。这里注入同一错误，确定性验证重试生效。
const injected = { remaining: 0, attempts: 0 };

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const rename = async (from: string, to: string): Promise<void> => {
		if (injected.remaining > 0 && to.endsWith("data.json")) {
			injected.remaining--;
			injected.attempts++;
			const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		}
		return actual.rename(from, to);
	};
	return { ...actual, rename };
});

const AGENT_DIR = "./test/.rename-agent";
const STATS_DIR_PATH = `${AGENT_DIR}/model-stats`;
const DATA_PATH = `${STATS_DIR_PATH}/data.json`;
const ERROR_LOG_PATH = `${STATS_DIR_PATH}/error.log`;
const model: ModelLike = { provider: "rename-provider", id: "rename-model", api: "openai-completions", baseUrl: "https://rename.test/v1" };

type DataFile = { buckets: Record<string, { days: Record<string, { total: number }> }> };

/** 直接读盘统计已持久化的观测数——bug 的本质是「没落盘」，断言必须针对磁盘而不是内存。 */
const persistedTotal = (): number => {
	try {
		const bucket = Object.values((JSON.parse(readFileSync(DATA_PATH, "utf8")) as DataFile).buckets)[0];
		return bucket ? Object.values(bucket.days).reduce((sum, day) => sum + day.total, 0) : 0;
	} catch { return 0; }
};

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const settle = async (predicate: () => boolean | Promise<boolean>, rounds = 600): Promise<void> => {
	for (let i = 0; i < rounds && !(await predicate()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

const freshStore = async (): Promise<StatsStore> => {
	await rm(AGENT_DIR, { recursive: true, force: true });
	await mkdir(STATS_DIR_PATH, { recursive: true });
	return StatsStore.create();
};

const observation = { result: "success", firstByteMs: 300, outputTokens: 7, generationMs: 1000 } as const;

afterEach(async () => {
	injected.remaining = 0;
	injected.attempts = 0;
	await rm(AGENT_DIR, { recursive: true, force: true });
});

describe("StatsStore writeAtomic rename retry", () => {
	it("retries transient EPERM instead of silently dropping the observation", async () => {
		const store = await freshStore();

		injected.remaining = 3; // 3 次失败后必须成功：锁定重试预算下限
		store.record(model, { ...observation, timestamp: Date.now() });

		await settle(() => persistedTotal() === 1);

		expect(persistedTotal()).toBe(1); // 先断言用户可见症状：观测必须落盘
		expect(injected.attempts).toBe(3);
		// 自愈成功就不该留诊断噪声
		expect(await exists(ERROR_LOG_PATH)).toBe(false);
	}, 30_000);

	it("logs and gives up once the retry budget is exhausted", async () => {
		const store = await freshStore();

		injected.remaining = Number.MAX_SAFE_INTEGER; // 永久失败
		store.record(model, { ...observation, timestamp: Date.now() });

		await settle(() => exists(ERROR_LOG_PATH));

		expect(persistedTotal()).toBe(0);
		expect(await exists(ERROR_LOG_PATH)).toBe(true);
		expect(readFileSync(ERROR_LOG_PATH, "utf8")).toContain("EPERM");
	}, 30_000);
});
