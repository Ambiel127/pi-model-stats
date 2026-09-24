export const DATA_SCHEMA_VERSION = 4 as const;

export type ResultCategory =
	| "success"
	| "network"
	| "timeout"
	| "rate_limit"
	| "server_error"
	| "authentication"
	| "permission"
	| "model_not_found"
	| "stream_error"
	| "malformed_response"
	| "request_rejected"
	| "cancelled"
	| "unknown";

export type ModelIdentity = {
	provider: string;
	modelId: string;
	configFingerprint: string;
};

export type Observation = {
	timestamp: number;
	result: ResultCategory;
	firstByteMs?: number;
	outputTokens?: number;
	generationMs?: number;
};

export type DailyStats = {
	total: number;
	byResult: Partial<Record<ResultCategory, number>>;
	firstByteDigest: { count: number; centroids: { mean: number; count: number }[] };
	outputTokens?: number;
	generationMs?: number;
};

export type RecentStats = {
	lastResults: string;
	consecutiveFailures: number;
	lastSuccessAt?: number;
	lastFailureAt?: number;
};

export type StatsBucket = {
	identity: ModelIdentity;
	recent: RecentStats;
	days: Record<string, DailyStats>;
};

export type StatsData = {
	schemaVersion: typeof DATA_SCHEMA_VERSION;
	buckets: Record<string, StatsBucket>;
};

export type StatsSummary = {
	todaySuccesses: number;
	todayAttempts: number;
	weekSuccesses: number;
	weekAttempts: number;
	firstByteP50?: number;
	firstByteP90?: number;
	weekTps?: number;
};

export type ModelLike = {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
	name?: string;
	compat?: unknown;
	samplingParams?: unknown;
	thinkingLevelMap?: unknown;
	input?: unknown;
	reasoning?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	headers?: Record<string, string>;
};
