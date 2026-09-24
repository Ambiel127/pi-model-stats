import { describe, expect, it } from "vitest";
import { addSample, mergeDigests, percentile, restoreDigest, serializeDigest, type Digest } from "../src/digest.js";

function build(values: number[]): Digest {
	let digest: Digest = { count: 0, centroids: [] };
	for (const value of values) digest = addSample(digest, value);
	return digest;
}

function expectQuantileError(digest: Digest, values: number[], quantiles: number[]): void {
	const sorted = [...values].sort((a, b) => a - b);
	for (const q of quantiles) {
		const exact = sorted[Math.ceil(q * sorted.length) - 1]!;
		const actual = percentile(digest, q)!;
		expect(Math.abs(actual - exact)).toBeLessThanOrEqual(Math.max(10, exact * 0.05));
	}
}

describe("t-digest", () => {
	it("handles empty, singleton, repeated, and boundary quantiles", () => {
		expect(percentile({ count: 0, centroids: [] }, 0.5)).toBeUndefined();
		const single = build([42]);
		expect(percentile(single, 0)).toBe(42);
		expect(percentile(single, 1)).toBe(42);
		const repeated = build(Array(1000).fill(25));
		expect(repeated.count).toBe(1000);
		expect(percentile(repeated, 0.5)).toBe(25);
		expect(percentile(repeated, 0.9)).toBe(25);
	});

	it("keeps centroid storage bounded for high-volume long-tail samples", () => {
		const values = Array.from({ length: 50_000 }, (_, i) => 80 + (i % 120));
		values.push(...Array.from({ length: 500 }, (_, i) => 500 + i * 10));
		const digest = build(values);
		expect(digest.count).toBe(values.length);
		expect(digest.centroids.length).toBeLessThanOrEqual(300);
		expectQuantileError(digest, values, [0.5, 0.9]);
	});

	it("preserves tail quantiles on a skewed latency distribution", () => {
		const values = Array.from({ length: 100_000 }, (_, i) => i % 100 === 0 ? 2_000 + i : 100 + (i % 40));
		const digest = build(values);
		expectQuantileError(digest, values, [0.5, 0.9, 0.99]);
		expect(digest.centroids.length).toBeLessThanOrEqual(300);
	});

	it("merges daily summaries and remains equivalent after serialization", () => {
		const left = build(Array.from({ length: 1000 }, (_, i) => 50 + i % 150));
		const right = build(Array.from({ length: 1000 }, (_, i) => 60 + i % 180));
		const merged = mergeDigests([left, right]);
		const restored = restoreDigest(serializeDigest(merged));
		expect(restored.count).toBe(2000);
		expect(percentile(restored, 0.5)).toBeCloseTo(percentile(merged, 0.5)!, 8);
		expect(percentile(restored, 0.9)).toBeCloseTo(percentile(merged, 0.9)!, 8);
	});

	it("ignores invalid sample values and weights without changing the digest", () => {
		const digest = build([1, 2, 3]);
		for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(addSample(digest, value)).toEqual(digest);
		for (const weight of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(addSample(digest, 4, weight)).toEqual(digest);
	});

	it("matches exact quantiles across reversed, bimodal, and repeated samples", () => {
		const cases = [
			Array.from({ length: 20_000 }, (_, i) => 20_000 - i),
			Array.from({ length: 20_000 }, (_, i) => i % 2 ? 10 + i % 7 : 10_000 + i % 11),
			Array.from({ length: 20_000 }, (_, i) => i % 100 ? 5 : 5000 + i),
		];
		for (const values of cases) {
			const digest = build(values);
			const sorted = [...values].sort((a, b) => a - b);
			for (const q of [0.5, 0.9, 0.99]) {
				const exact = sorted[Math.ceil(q * sorted.length) - 1]!;
				expect(Math.abs(percentile(digest, q)! - exact)).toBeLessThan(250);
			}
			expect(digest.centroids.length).toBeLessThanOrEqual(300);
		}
	});

	it("preserves exact extrema and monotonic quantiles across shuffled heavy-tail samples", () => {
		const values = [0, ...Array.from({ length: 49_998 }, (_, i) => 10 + (i % 9)), 1_000_000];
		let seed = 42;
		for (let i = values.length - 1; i > 0; i--) {
			seed = (seed * 16807) % 2147483647;
			const j = seed % (i + 1);
			[values[i], values[j]] = [values[j]!, values[i]!];
		}
		const digest = build(values);
		const sorted = [...values].sort((a, b) => a - b);
		const quantiles = [0, 0.5, 0.9, 0.99, 0.999, 1].map((q) => percentile(digest, q)!);
		expect(quantiles[0]).toBe(sorted[0]);
		expect(quantiles.at(-1)).toBe(sorted.at(-1));
		expect(quantiles).toEqual([...quantiles].sort((a, b) => a - b));
		expectQuantileError(digest, values, [0.5, 0.9, 0.99, 0.999]);
		expect(digest.centroids.length).toBeLessThanOrEqual(300);
	});

	it("honors weighted samples, clamps quantiles, and rejects non-finite quantiles", () => {
		const digest = addSample({ count: 0, centroids: [] }, 10, 100);
		expect(digest.count).toBe(100);
		expect(percentile(digest, -1)).toBe(10);
		expect(percentile(digest, 2)).toBe(10);
		expect(percentile(digest, Number.NaN)).toBeUndefined();
		expect(percentile({ count: 0, centroids: [] }, 0.5)).toBeUndefined();
	});

	it("keeps merged quantiles accurate when daily digests have different sizes", () => {
		const days = [
			build(Array.from({ length: 30_000 }, (_, i) => 20 + i % 11)),
			build([5_000, 8_000]),
			build(Array.from({ length: 7_000 }, (_, i) => 100 + i % 17)),
		];
		const merged = mergeDigests(days);
		const allValues = [...Array.from({ length: 30_000 }, (_, i) => 20 + i % 11), 5_000, 8_000, ...Array.from({ length: 7_000 }, (_, i) => 100 + i % 17)].sort((a, b) => a - b);
		expectQuantileError(merged, allValues, [0.5, 0.9, 0.99]);
	});

	it("rejects invalid persisted summaries", () => {
		expect(() => restoreDigest({ count: 1, centroids: [{ mean: -1, count: 1 }] })).toThrow();
		expect(() => restoreDigest({ count: 2, centroids: [{ mean: 5, count: 1 }] })).toThrow();
	});
});
