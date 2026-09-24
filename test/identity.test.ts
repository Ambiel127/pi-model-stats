import { describe, expect, it } from "vitest";
import { getBucketId, getConfigFingerprint } from "../src/identity.js";

describe("model identity", () => {
	const base = {
		provider: "proxy",
		id: "model-a",
		api: "openai-completions",
		baseUrl: "https://example.test/v1/",
		compat: { supportsDeveloperRole: false },
	};

	it("normalizes endpoint slashes and excludes secrets", () => {
		const left = getConfigFingerprint({ ...base, baseUrl: "https://example.test/v1///", apiKey: "secret-a" } as never);
		const right = getConfigFingerprint({ ...base, apiKey: "secret-b" } as never);
		expect(left).toBe(right);
	});

	it("separates meaningful endpoint, api and compatibility changes", () => {
		const original = getConfigFingerprint(base);
		expect(getConfigFingerprint({ ...base, baseUrl: "https://other.test/v1" }) === original).toBe(false);
		expect(getConfigFingerprint({ ...base, api: "anthropic-messages" }) === original).toBe(false);
		expect(getConfigFingerprint({ ...base, compat: { supportsDeveloperRole: true } }) === original).toBe(false);
		expect(getConfigFingerprint({ ...base, headers: { "x-route": "a" } }) === getConfigFingerprint({ ...base, headers: { "x-route": "b" } })).toBe(false);
		expect(getConfigFingerprint({ ...base, headers: { authorization: "secret-a" } }) === getConfigFingerprint({ ...base, headers: { authorization: "secret-b" } })).toBe(true);
	});

	it("produces the same fingerprint when object keys are reordered", () => {
		const left = getConfigFingerprint({ ...base, compat: { supportsDeveloperRole: false, supportsTools: true }, samplingParams: { temperature: 0.2, topP: 0.9 } });
		const right = getConfigFingerprint({ ...base, compat: { supportsTools: true, supportsDeveloperRole: false }, samplingParams: { topP: 0.9, temperature: 0.2 } });
		expect(left).toBe(right);
	});

	it("keeps secret-only changes stable while separating sampling and routing options", () => {
		const original = getConfigFingerprint({ ...base, samplingParams: { temperature: 0.2 }, headers: { "x-route": "blue", authorization: "secret-a" } });
		expect(getConfigFingerprint({ ...base, samplingParams: { temperature: 0.2 }, headers: { "x-route": "blue", authorization: "secret-b" } })).toBe(original);
		expect(getConfigFingerprint({ ...base, samplingParams: { temperature: 0.8 }, headers: { "x-route": "blue" } })).not.toBe(original);
		expect(getConfigFingerprint({ ...base, samplingParams: { temperature: 0.2 }, headers: { "x-route": "green" } })).not.toBe(original);
	});

	it("keeps provider/model identities separate", () => {
		expect(
			getBucketId({ provider: "a", modelId: "same", configFingerprint: "x" }) ===
				getBucketId({ provider: "b", modelId: "same", configFingerprint: "x" }),
		).toBe(false);
	});
});
