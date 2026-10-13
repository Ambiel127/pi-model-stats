import { describe, expect, it } from "vitest";
import { classifyError, dayKey, formatAvailability, formatFirstByte, formatStatsFields, resultFromStopReason, summarizeDays, summarizeObservations } from "../src/metrics.js";

describe("metrics", () => {
	it("maps stop reasons and summarizes daily observations", () => {
		expect(resultFromStopReason("stop")).toBe("success");
		expect(resultFromStopReason("toolUse")).toBe("success");
		expect(resultFromStopReason("length")).toBe("success");
		expect(resultFromStopReason("aborted")).toBe("cancelled");
		const now = new Date(2025, 0, 8, 12).getTime();
		const summary = summarizeObservations([
			{ timestamp: now, result: "success", firstByteMs: 100, outputTokens: 400, generationMs: 10000 },
			{ timestamp: now - 1000, result: "server_error", firstByteMs: 200 },
			{ timestamp: now - 2000, result: "request_rejected" },
			{ timestamp: now - 3000, result: "cancelled" },
			{ timestamp: now - 8 * 24 * 60 * 60 * 1000, result: "success", firstByteMs: 5 },
		], now);
		expect(summary.todaySuccesses).toBe(1);
		expect(summary.todayAttempts).toBe(2);
		expect(summary.weekSuccesses).toBe(1);
		expect(summary.weekAttempts).toBe(2);
		expect(summary.firstByteP50).toBe(100);
		expect(summary.firstByteP90).toBe(200);
		expect(summary.weekTps).toBe(40);
		expect(formatAvailability(1, 2)).toBe("1/2");
		expect(formatAvailability(0, 0)).toBe("—");
	});

	it("keys days by local calendar date, not UTC", () => {
		expect(dayKey(new Date(2025, 0, 2, 0, 0).getTime())).toBe("2025-01-02");
		expect(dayKey(new Date(2025, 0, 2, 23, 59).getTime())).toBe("2025-01-02");
		expect(dayKey(new Date(2025, 0, 3, 0, 0).getTime())).toBe("2025-01-03");
		// 本地午夜前后必须跳日：旧的 UTC 实现在正偏移时区会把 00:00-07:59 归到前一天，两边相等。
		expect(dayKey(new Date(2025, 0, 2, 0, 30).getTime())).not.toBe(dayKey(new Date(2025, 0, 1, 23, 30).getTime()));
	});

	it("spans exactly seven local calendar days including today", () => {
		const now = new Date(2025, 2, 10, 12).getTime();
		const days: Record<string, { total: number; byResult: { success: number }; firstByteDigest: { count: number; centroids: [] } }> = {};
		for (let offset = 0; offset < 8; offset++) {
			days[dayKey(new Date(2025, 2, 10 - offset, 12).getTime())] = { total: 1, byResult: { success: 1 }, firstByteDigest: { count: 0, centroids: [] } };
		}
		// 8 个连续本地日历日（跨越 3 月 9 日 DST 切换），只算含今日在内的最近 7 天。
		const summary = summarizeDays(days, now);
		expect(summary.weekSuccesses).toBe(7);
		expect(summary.weekAttempts).toBe(7);
		expect(summary.todaySuccesses).toBe(1);
	});

	it("uses a local calendar window across year boundaries and excludes future days", () => {
		// 均用本地时间构造，使断言不依赖运行机器的时区。
		const now = new Date(2025, 0, 2, 12).getTime();
		const summary = summarizeObservations([
			{ timestamp: new Date(2025, 0, 2, 1).getTime(), result: "success" },
			{ timestamp: new Date(2025, 0, 1, 23).getTime(), result: "server_error" },
			{ timestamp: new Date(2024, 11, 27, 0).getTime(), result: "success" },
			{ timestamp: new Date(2024, 11, 26, 23).getTime(), result: "success" },
			{ timestamp: new Date(2025, 0, 3, 0).getTime(), result: "success" },
		], now);
		expect(summary.todaySuccesses).toBe(1);
		expect(summary.todayAttempts).toBe(1);
		expect(summary.weekSuccesses).toBe(2);
		expect(summary.weekAttempts).toBe(3);
	});

	it("classifies known failures conservatively", () => {
		expect(classifyError(401)).toBe("authentication");
		expect(classifyError(429)).toBe("rate_limit");
		expect(classifyError(503)).toBe("server_error");
		expect(classifyError(400, "invalid request: context length exceeded")).toBe("request_rejected");
		expect(classifyError(undefined, "something odd")).toBe("unknown");
		expect(classifyError(undefined, "unexpected provider failure")).toBe("unknown");
		expect(classifyError(undefined, "stream closed unexpectedly")).toBe("stream_error");
	});

	it("formats first-byte display units", () => {
		expect(formatFirstByte(150)).toBe("150ms");
		expect(formatFirstByte(1500)).toBe("1.5s");
		expect(formatFirstByte(undefined)).toBe("—");
	});

	it("orders stats fields by display priority and omits them without week data", () => {
		const summary = { todaySuccesses: 1, todayAttempts: 2, weekSuccesses: 3, weekAttempts: 4, firstByteP50: 1500, firstByteP90: 2400, weekTps: 40.24 };
		expect(formatStatsFields(summary)).toEqual(["1d 1/2", "7d 3/4", "P50 1.5s", "P90 2.4s", "TPS 40.2"]);
		expect(formatStatsFields({ ...summary, weekTps: undefined })[4]).toBe("TPS —");
		expect(formatStatsFields({ ...summary, firstByteP90: undefined })[3]).toBe("P90 —");
		expect(formatStatsFields({ todaySuccesses: 0, todayAttempts: 0, weekSuccesses: 0, weekAttempts: 0 })).toEqual([]);
	});

});
