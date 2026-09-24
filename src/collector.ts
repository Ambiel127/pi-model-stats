import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyError, resultFromStopReason } from "./metrics.js";
import { getBucketId, getModelIdentity } from "./identity.js";
import { StatsStore } from "./storage.js";
import type { ModelLike, Observation, ResultCategory } from "./types.js";

type PendingAttempt = {
	model: ModelLike;
	outputTokens?: number;
	identityId: string;
	startedAt: number;
	firstByteMs?: number;
	firstTokenAt?: number;
	httpStatus?: number;
	retryCount?: number;
};

function asModel(value: unknown): ModelLike | undefined {
	if (!value || typeof value !== "object") return undefined;
	const model = value as Partial<ModelLike>;
	if (typeof model.provider !== "string" || typeof model.id !== "string" || typeof model.api !== "string" || typeof model.baseUrl !== "string") return undefined;
	return model as ModelLike;
}

function messageModel(message: unknown): ModelLike | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = message as { provider?: unknown; model?: unknown; api?: unknown };
	if (typeof value.provider !== "string" || typeof value.model !== "string" || typeof value.api !== "string") return undefined;
	return { provider: value.provider, id: value.model, api: value.api, baseUrl: "" };
}

export function createCollector(pi: ExtensionAPI, store: StatsStore): void {
	const pending: PendingAttempt[] = [];
	const headerStarts = new Map<string, number[]>();

	function currentModel(ctx: ExtensionContext): ModelLike | undefined {
		return asModel(ctx.model);
	}

	function removeAttempt(attempt: PendingAttempt): void {
		const index = pending.indexOf(attempt);
		if (index >= 0) pending.splice(index, 1);
	}

	function findLatest(model: ModelLike | undefined): PendingAttempt | undefined {
		if (!model) return pending[pending.length - 1];
		const identityId = model.baseUrl ? getBucketId(getModelIdentity(model)) : undefined;
		for (let index = pending.length - 1; index >= 0; index--) {
			const candidate = pending[index]!;
			if (
				identityId
					? candidate.identityId === identityId
					: candidate.model.provider === model.provider && candidate.model.id === model.id && candidate.model.api === model.api
			) {
				return candidate;
			}
		}
		return undefined;
	}

	function record(attempt: PendingAttempt, result: ResultCategory): void {
		removeAttempt(attempt);
		const observation: Observation = {
			timestamp: Date.now(),
			result,
		};
		if (attempt.firstByteMs !== undefined) observation.firstByteMs = attempt.firstByteMs;
		store.record(attempt.model, observation);
	}

	pi.on("before_provider_headers", (_event, ctx) => {
		const model = currentModel(ctx);
		if (!model) return;
		const identityId = getBucketId(getModelIdentity(model));
		const starts = headerStarts.get(identityId) ?? [];
		starts.push(Date.now());
		headerStarts.set(identityId, starts);
	});

	pi.on("before_provider_request", (_event, ctx) => {
		const model = currentModel(ctx);
		if (!model) return;
		const identityId = getBucketId(getModelIdentity(model));
		const starts = headerStarts.get(identityId) ?? [];
		const headerStart = starts.shift();
		if (starts.length === 0) headerStarts.delete(identityId);
		else headerStarts.set(identityId, starts);
		// before_provider_request fires for every provider attempt, including retries.
		// before_provider_headers marks the logical request; reuse its pending record
		// across retries so a retry is not inflated into a separate user-visible request.
		if (headerStart === undefined) {
			const attempt = findLatest(model);
			if (attempt) {
				return;
			}
		}
		pending.push({ model, identityId, startedAt: headerStart ?? Date.now() });
	});

	pi.on("after_provider_response", (event, ctx) => {
		const attempt = findLatest(currentModel(ctx));
		if (!attempt) return;
		// Failed retry responses are attempts, but the user-visible request is counted
		// once at its final message_end outcome.
		if (event.status >= 400 && event.status < 500) {
			if (attempt.retryCount) return;
			attempt.retryCount = 1;
		}
		// Keep the attempt open so the normalized assistant error message can
		// refine 4xx/5xx classification at message_end.
		attempt.httpStatus = event.status;
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const eventUsage = (event as typeof event & { usage?: { output?: unknown } }).usage;
		const messageUsage = (event.message as typeof event.message & { usage?: { output?: unknown } }).usage;
		const outputValue = eventUsage?.output ?? messageUsage?.output;
		const model = messageModel(event.message);
		if (!model) return;
		const matching = pending.filter((candidate) => candidate.model.provider === model.provider && candidate.model.id === model.id && candidate.model.api === model.api);
		if (matching.length !== 1) return;
		const attempt = matching[0]!;
		if (typeof outputValue === "number" && Number.isFinite(outputValue) && outputValue > 0) attempt.outputTokens = outputValue;
		if (attempt.firstByteMs !== undefined) return;
		const type = event.assistantMessageEvent?.type;
		if (type === "text_start" || type === "text_delta" || type === "thinking_start" || type === "thinking_delta" || type === "toolcall_start" || type === "toolcall_delta") {
			attempt.firstByteMs = Math.max(0, Date.now() - attempt.startedAt);
			attempt.firstTokenAt = Date.now();
		}
	});

	pi.on("session_shutdown", () => {
		pending.length = 0;
		headerStarts.clear();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const attempt = findLatest(messageModel(event.message));
		if (!attempt) return;
		const stopReason = event.message.stopReason;
		if (stopReason === "error") {
			record(attempt, classifyError(attempt.httpStatus, event.message.errorMessage));
		} else if (stopReason === "aborted") {
			record(attempt, "cancelled");
		} else {
			const result = resultFromStopReason(stopReason);
			if (result === "success") {
				const message = event.message as typeof event.message & { usage?: { output?: unknown } };
				const finalUsage = message.usage;
				const outputTokens = finalUsage?.output ?? attempt.outputTokens;
				const generationMs = attempt.firstTokenAt === undefined ? 0 : Date.now() - attempt.firstTokenAt;
				if (typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0 && generationMs > 0) {
					const observation: Observation = { timestamp: Date.now(), result, outputTokens, generationMs };
					if (attempt.firstByteMs !== undefined) observation.firstByteMs = attempt.firstByteMs;
					store.record(attempt.model, observation);
					removeAttempt(attempt);
					return;
				}
			}
			record(attempt, result);
		}
	});
}
