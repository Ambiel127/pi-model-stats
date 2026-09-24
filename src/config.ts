import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const STATS_DIR = join(getAgentDir(), "model-stats");
export const DATA_PATH = join(STATS_DIR, "data.json");
export const ERROR_LOG_PATH = join(STATS_DIR, "error.log");
export const LOCK_PATH = join(STATS_DIR, ".lock");
