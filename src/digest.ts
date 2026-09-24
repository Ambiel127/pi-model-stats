export type Centroid = { mean: number; count: number };
export type Digest = { count: number; centroids: Centroid[] };

const COMPRESSION = 100;
const MAX_CENTROIDS = 300;

export function addSample(digest: Digest, value: number, weight = 1): Digest {
	if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(weight) || weight <= 0) return digest;
	const centroids = digest.centroids.map((centroid) => ({ ...centroid }));
	let low = 0, high = centroids.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (centroids[middle]!.mean < value) low = middle + 1;
		else high = middle;
	}
	let nearest = low;
	if (low > 0 && (low === centroids.length || value - centroids[low - 1]!.mean <= centroids[low]!.mean - value)) nearest = low - 1;
	const existing = centroids[nearest];
	if (existing && Math.abs(existing.mean - value) === 0) {
		existing.mean += weight * (value - existing.mean) / (existing.count + weight);
		existing.count += weight;
	} else {
		let cumulative = 0;
		for (let i = 0; i < nearest; i++) cumulative += centroids[i]!.count;
		const q = digest.count === 0 ? 0 : (cumulative + (existing?.count ?? 0) / 2) / digest.count;
		const capacity = Math.max(1, Math.floor(4 * digest.count * q * (1 - q) / COMPRESSION));
		if (existing && (existing.mean === value || existing.count + weight <= capacity)) {
			existing.mean += weight * (value - existing.mean) / (existing.count + weight);
			existing.count += weight;
		} else centroids.splice(low, 0, { mean: value, count: weight });
	}
	const next = { count: digest.count + weight, centroids };
	return centroids.length > MAX_CENTROIDS ? compress(next) : next;
}

function compress(digest: Digest): Digest {
	const output: Centroid[] = [];
	let cumulative = 0;
	for (const centroid of digest.centroids) {
		const last = output[output.length - 1];
		const q = digest.count ? (cumulative + (last?.count ?? 0) / 2) / digest.count : 0;
		const capacity = Math.max(1, Math.floor(4 * digest.count * q * (1 - q) / COMPRESSION));
		if (last && last.count + centroid.count <= capacity) {
			const combined = last.count + centroid.count;
			last.mean += centroid.count * (centroid.mean - last.mean) / combined;
			last.count = combined;
		} else {
			output.push({ ...centroid });
			cumulative += centroid.count;
		}
	}
	if (output.length > MAX_CENTROIDS) {
		for (let i = 1; output.length > MAX_CENTROIDS; i++) {
			const index = Math.min(output.length - 2, Math.floor(i * (output.length - 2) / (MAX_CENTROIDS - 1)) + 1);
			const left = output[index - 1]!, right = output[index]!;
			const count = left.count + right.count;
			left.mean = (left.mean * left.count + right.mean * right.count) / count;
			left.count = count;
			output.splice(index, 1);
		}
	}
	return { count: digest.count, centroids: output };
}

export function mergeDigests(digests: Digest[]): Digest {
	let merged: Digest = { count: 0, centroids: [] };
	for (const digest of digests) for (const centroid of digest.centroids) merged = addSample(merged, centroid.mean, centroid.count);
	return merged;
}

export function percentile(digest: Digest, quantile: number): number | undefined {
	if (!digest.count || !digest.centroids.length || !Number.isFinite(quantile)) return undefined;
	const rank = Math.max(0, Math.min(digest.count - 1, Math.ceil(Math.max(0, Math.min(1, quantile)) * digest.count) - 1));
	let cumulative = 0;
	for (const centroid of digest.centroids) {
		if (rank < cumulative + centroid.count) return centroid.mean;
		cumulative += centroid.count;
	}
	return digest.centroids[digest.centroids.length - 1]!.mean;
}

export function serializeDigest(digest: Digest): Digest {
	return { count: digest.count, centroids: digest.centroids.map(({ mean, count }) => ({ mean, count })) };
}

export function restoreDigest(value: unknown): Digest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid digest schema");
	const candidate = value as { count?: unknown; centroids?: unknown };
	if (!Number.isSafeInteger(candidate.count) || (candidate.count as number) < 0 || !Array.isArray(candidate.centroids)) throw new Error("invalid digest schema");
	let sum = 0, previous = -Infinity;
	const centroids: Centroid[] = candidate.centroids.map((item) => {
		if (!item || typeof item !== "object") throw new Error("invalid digest schema");
		const { mean, count } = item as Centroid;
		if (!Number.isFinite(mean) || mean < 0 || !Number.isSafeInteger(count) || count <= 0 || mean < previous) throw new Error("invalid digest schema");
		previous = mean;
		sum += count;
		return { mean, count };
	});
	if (sum !== candidate.count) throw new Error("invalid digest schema");
	return { count: candidate.count as number, centroids };
}
