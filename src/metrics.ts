import type { ResultCategory, StatsSummary, Observation } from "./types.js";
import { addSample, mergeDigests, percentile as digestPercentile, restoreDigest, type Digest } from "./digest.js";

const SUCCESS_REASONS = new Set(["stop", "toolUse", "length"]);

export function resultFromStopReason(stopReason: unknown): ResultCategory {
	if (SUCCESS_REASONS.has(String(stopReason))) return "success";
	if (stopReason === "aborted") return "cancelled";
	return "unknown";
}

function textOf(errorMessage: unknown): string {
	return typeof errorMessage === "string" ? errorMessage.toLowerCase() : "";
}

export function classifyError(status?: number, errorMessage?: unknown): ResultCategory {
	const message = textOf(errorMessage);
	if (status === 401 || /unauthori[sz]ed|invalid api key|authentication|credential/.test(message)) return "authentication";
	if (status === 403 || /forbidden|permission|access denied/.test(message)) return "permission";
	if (status === 404 && /model|deployment|engine/.test(message)) return "model_not_found";
	if (/model (not found|does not exist|unavailable)|unknown model|no such model/.test(message)) return "model_not_found";
	if (status === 429 || /rate.?limit|too many requests|quota exceeded|throttl/.test(message)) return "rate_limit";
	if (status === 408 || /timeout|timed out|deadline exceeded|etimedout/.test(message)) return "timeout";
	if (status !== undefined && status >= 500 && status <= 599) return "server_error";
	if (/network|econn|enotfound|socket|connection reset|fetch failed|dns/.test(message)) return "network";
	if (/stream|premature end|body.*closed|incomplete|closed unexpectedly/.test(message)) return "stream_error";
	if (/json|parse|malformed|invalid response|unexpected token|schema/.test(message)) return "malformed_response";
	if ((status === 400 || status === 422) && /invalid (request|parameter|argument)|bad request|context length|too many tokens|unsupported (parameter|feature)|validation|schema/.test(message)) return "request_rejected";
	return "unknown";
}

export function dayKey(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function isProviderFailure(result: ResultCategory): boolean {
	return result !== "success" && result !== "request_rejected" && result !== "cancelled";
}

export function summarizeDays(days: Record<string, { total: number; byResult: Partial<Record<ResultCategory, number>>; firstByteDigest: Digest; outputTokens?: number; generationMs?: number }>, now = Date.now()): StatsSummary {
	const today = dayKey(now);
	const weekStart = new Date(`${today}T00:00:00.000Z`);
	weekStart.setUTCDate(weekStart.getUTCDate() - 6);
	let todaySuccesses = 0, todayAttempts = 0, weekSuccesses = 0, weekAttempts = 0;
	const latencyDigests: Digest[] = [];
	let weekOutputTokens = 0, weekGenerationMs = 0;
	for (const [key, stats] of Object.entries(days)) {
		const date = new Date(`${key}T00:00:00.000Z`);
		if (key > today || date < weekStart) continue;
		const successes = stats.byResult.success ?? 0;
		const failureCount = Object.entries(stats.byResult).reduce((sum, [result, count]) => sum + (result !== "success" && result !== "request_rejected" && result !== "cancelled" ? count ?? 0 : 0), 0);
		const attempts = successes + failureCount;
		latencyDigests.push(restoreDigest(stats.firstByteDigest));
		if (key === today) { todaySuccesses = successes; todayAttempts = attempts; }
		weekSuccesses += successes;
		weekAttempts += attempts;
		weekOutputTokens += Number.isFinite(stats.outputTokens) ? stats.outputTokens! : 0;
		weekGenerationMs += Number.isFinite(stats.generationMs) ? stats.generationMs! : 0;
	}
	const latencyDigest = mergeDigests(latencyDigests);
	return { todaySuccesses, todayAttempts, weekSuccesses, weekAttempts, firstByteP50: digestPercentile(latencyDigest, 0.5), firstByteP90: digestPercentile(latencyDigest, 0.9), weekTps: weekOutputTokens > 0 && weekGenerationMs > 0 ? weekOutputTokens * 1000 / weekGenerationMs : undefined };
}

export function summarizeObservations(observations: Observation[], now = Date.now()): StatsSummary {
	const days: Record<string, { total: number; byResult: Partial<Record<ResultCategory, number>>; firstByteDigest: Digest; outputTokens?: number; generationMs?: number }> = {};
	for (const observation of observations) {
		const key = dayKey(observation.timestamp);
		const day = days[key] ??= { total: 0, byResult: {}, firstByteDigest: { count: 0, centroids: [] } };
		day.total++;
		day.byResult[observation.result] = (day.byResult[observation.result] ?? 0) + 1;
		if (observation.firstByteMs !== undefined) day.firstByteDigest = addSample(day.firstByteDigest, observation.firstByteMs);
		if (observation.result === "success" && observation.outputTokens !== undefined && observation.generationMs !== undefined && observation.outputTokens > 0 && observation.generationMs > 0) {
			day.outputTokens = (day.outputTokens ?? 0) + observation.outputTokens;
			day.generationMs = (day.generationMs ?? 0) + observation.generationMs;
		}
	}
	return summarizeDays(days, now);
}

export function formatFirstByte(value: number | undefined): string {
	if (value === undefined) return "首字 —";
	if (value < 1000) return `首字 ${Math.round(value)}ms`;
	const seconds = value / 1000;
	return `首字 ${seconds.toFixed(seconds >= 10 ? 0 : 1).replace(/\.0$/, "")}s`;
}

export function formatAvailability(successes: number, attempts: number): string {
	return attempts === 0 ? "—" : `${successes}/${attempts}`;
}
