import { describe, expect, it } from "vitest";
import { createCollector } from "../src/collector.js";
import type { ModelLike, Observation } from "../src/types.js";

type Handler = (event: any, context: any) => void;

function harness() {
	const handlers = new Map<string, Handler[]>();
	const observations: Observation[] = [];
	const model: ModelLike = {
		provider: "test-provider",
		id: "test-model",
		api: "openai-completions",
		baseUrl: "https://provider.test/v1",
	};
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	const store = { record(_model: ModelLike, observation: Observation) { observations.push(observation); } };
	const context = { model };
	createCollector(pi as any, store as any);
	return {
		model,
		observations,
		emit(name: string, event: any = {}, ctx = context) {
			for (const handler of handlers.get(name) ?? []) handler(event, ctx);
		},
	};
}

function assistant(model: ModelLike, stopReason: string, errorMessage?: string, output = 0) {
	return { role: "assistant", provider: model.provider, model: model.id, api: model.api, stopReason, errorMessage, usage: { output } } as any;
}

describe("collector runtime boundary", () => {
	it("records a successful streamed request and first-byte time", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		const stream = assistant(h.model, "pending") as any;
		h.emit("message_update", {
			message: stream,
			usage: { output: 400 },
			assistantMessageEvent: { type: "text_delta", delta: "ok" },
		});
		const finalMessage = assistant(h.model, "stop", undefined, 400);
		h.emit("message_end", { message: finalMessage });
		expect(h.observations).toHaveLength(1);
		expect(h.observations[0]?.result).toBe("success");
		expect(h.observations[0]?.firstByteMs).toEqual(expect.any(Number));

	});

	it("keeps first-byte timing only when the stream maps to one model request", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("message_update", { message: assistant(h.model, "pending"), assistantMessageEvent: { type: "text_delta", delta: "x" } });
		h.emit("message_end", { message: assistant(h.model, "stop") });
		expect(h.observations[0]?.firstByteMs).toEqual(expect.any(Number));
	});

	it("does not associate an update with an ambiguous model-less request", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("message_update", { message: { role: "assistant", provider: h.model.provider, model: h.model.id, api: h.model.api }, assistantMessageEvent: { type: "text_delta", delta: "x" } });
		h.emit("message_end", { message: assistant(h.model, "stop") });
		h.emit("message_end", { message: assistant(h.model, "stop") });
		expect(h.observations).toHaveLength(2);
		expect(h.observations.every(({ firstByteMs }) => firstByteMs === undefined)).toBe(true);
	});

	it("does not create TPS metrics when provider usage is absent", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("message_update", {
			message: assistant(h.model, "pending"),
			assistantMessageEvent: { type: "text_delta", delta: "ok" },
		});
		h.emit("message_end", { message: assistant(h.model, "stop") });
		expect(h.observations).toHaveLength(1);
		expect(h.observations[0]).not.toHaveProperty("outputTokens");
		expect(h.observations[0]).not.toHaveProperty("generationMs");
	});

	it("stores only the classified failure, not provider error text", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("message_end", { message: assistant(h.model, "error", "Bearer super-secret") });
		expect(h.observations[0]?.result).toBe("unknown");
		expect(JSON.stringify(h.observations)).not.toContain("super-secret");
	});

	it("keeps first-byte timing when the stream later fails", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("message_update", {
			message: { ...assistant(h.model, "pending"), baseUrl: h.model.baseUrl },
			assistantMessageEvent: { type: "thinking_start" },
		});
		h.emit("message_end", { message: assistant(h.model, "error", "stream closed unexpectedly") });
		expect(h.observations[0]?.result).toBe("stream_error");
		expect(h.observations[0]?.firstByteMs).toEqual(expect.any(Number));
	});

	it("classifies HTTP failures and does not invent first-byte timing", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("after_provider_response", { status: 408 });
		h.emit("message_end", { message: assistant(h.model, "error", "request timed out") });
		expect(h.observations).toEqual([{ timestamp: expect.any(Number), result: "timeout" }]);
	});

	it("classifies same-model requests by the available event order (not guaranteed correlation)", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("after_provider_response", { status: 408 }, { model: h.model });
		h.emit("message_end", { message: assistant(h.model, "error", "request timed out") });
		h.emit("message_end", { message: assistant(h.model, "stop") });
		expect(h.observations.map(({ result }) => result)).toEqual(["timeout", "success"]);
		expect(h.observations).toHaveLength(2);
	});

	it("matches requests from different models by available model identity", () => {
		const h = harness();
		const other = { ...h.model, provider: "other-provider", id: "other-model", baseUrl: "https://other.test/v1" };
		h.emit("before_provider_headers", {}, { model: h.model });
		h.emit("before_provider_request", {}, { model: h.model });
		h.emit("before_provider_headers", {}, { model: other });
		h.emit("before_provider_request", {}, { model: other });
		h.emit("message_end", { message: assistant(h.model, "stop") });
		h.emit("message_end", { message: assistant(other, "error", "upstream unavailable") });
		expect(h.observations.map(({ result }) => result)).toEqual(["success", "stream_error"]);
	});

	it("clears pending requests on shutdown and ignores late completion", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("session_shutdown");
		h.emit("message_end", { message: assistant(h.model, "stop") });
		expect(h.observations).toHaveLength(0);
	});

	it.each([408, 429, 503])("keeps a request open after retryable HTTP %i", (status) => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("before_provider_request");
		h.emit("after_provider_response", { status });
		expect(h.observations).toHaveLength(0);
		h.emit("message_end", { message: assistant(h.model, "error", status === 429 ? "rate limit exceeded" : status === 503 ? "server error" : "request timed out") });
		expect(h.observations).toHaveLength(1);
		expect(h.observations[0]?.result).toBe(status === 429 ? "rate_limit" : status === 503 ? "server_error" : "timeout");
	});

	it("does not let an earlier request status leak into the next one", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("after_provider_response", { status: 429 });
		h.emit("message_end", { message: assistant(h.model, "error", "rate limited") });
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("message_end", { message: assistant(h.model, "error", "unexpected fault") });
		expect(h.observations.map(({ result }) => result)).toEqual(["rate_limit", "unknown"]);
	});

	it("keeps a request across provider retries", () => {
		const h = harness();
		h.emit("before_provider_headers");
		h.emit("before_provider_request");
		h.emit("before_provider_request");
		expect(h.observations).toHaveLength(0);
		h.emit("message_update", {
			message: assistant(h.model, "pending"),
			assistantMessageEvent: { type: "text_delta", delta: "ok" },
		});
		h.emit("message_end", { message: assistant(h.model, "stop") });
		expect(h.observations).toHaveLength(1);
		expect(h.observations[0]?.result).toBe("success");
	});
});
