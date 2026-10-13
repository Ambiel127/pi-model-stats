import { describe, expect, it } from "vitest";
import { classifyError, formatAvailability, formatFirstByte, formatStatsFields, resultFromStopReason, summarizeObservations } from "../src/metrics.js";

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

	it("uses a UTC calendar window across year boundaries and excludes future days", () => {
		const now = Date.UTC(2025, 0, 2, 12);
		const summary = summarizeObservations([
			{ timestamp: Date.UTC(2025, 0, 2), result: "success" },
			{ timestamp: Date.UTC(2025, 0, 1), result: "server_error" },
			{ timestamp: Date.UTC(2024, 11, 27), result: "success" },
			{ timestamp: Date.UTC(2024, 11, 26), result: "success" },
			{ timestamp: Date.UTC(2025, 0, 3), result: "success" },
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
