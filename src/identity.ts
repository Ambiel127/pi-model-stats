import { createHash } from "node:crypto";
import type { ModelIdentity, ModelLike } from "./types.js";

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function isSensitiveKey(key: string): boolean {
	return /(api.?key|authorization|auth|bearer|cookie|header|secret|token|password|prompt|response|body|payload)/i.test(key);
}

function normalizeValue(value: unknown, key?: string): unknown {
	if (key && isSensitiveKey(key)) return undefined;
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const name of Object.keys(value as Record<string, unknown>).sort()) {
			if (isSensitiveKey(name)) continue;
			const normalized = normalizeValue((value as Record<string, unknown>)[name], name);
			if (normalized !== undefined) result[name] = normalized;
		}
		return result;
	}
	return value;
}

function normalizeRoutingHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	if (!headers) return {};
	const result: Record<string, string> = {};
	for (const name of Object.keys(headers).sort()) {
		if (isSensitiveKey(name)) continue;
		if (!/(route|routing|region|project|tenant|deployment|variant|profile|gateway|target|backend|model)/i.test(name)) continue;
		result[name.toLowerCase()] = headers[name]!;
	}
	return result;
}

export function getConfigFingerprint(model: ModelLike): string {
	const fingerprintInput = {
		api: model.api,
		baseUrl: normalizeBaseUrl(model.baseUrl),
		compat: normalizeValue(model.compat),
		headers: normalizeRoutingHeaders(model.headers),
		provider: model.provider,
		samplingParams: normalizeValue(model.samplingParams),
		thinkingLevelMap: normalizeValue(model.thinkingLevelMap),
	};
	return createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
}

export function getModelIdentity(model: ModelLike): ModelIdentity {
	return {
		provider: model.provider,
		modelId: model.id,
		configFingerprint: getConfigFingerprint(model),
	};
}

export function getBucketId(identity: ModelIdentity): string {
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
