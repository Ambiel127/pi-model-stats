import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function modelStats(pi: ExtensionAPI): Promise<void> {
	process.env.PI_MODEL_STATS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../agent/model-stats");
	const { default: loadModelStats } = await import("../../../src/index.ts");
	await loadModelStats(pi);
}
