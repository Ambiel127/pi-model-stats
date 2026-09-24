import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "C:/model-stats-test-agent" }));

import { DATA_PATH, ERROR_LOG_PATH, LOCK_PATH, STATS_DIR } from "../src/config.js";

describe("configuration-free storage paths", () => {
	it("keeps runtime data in the agent model-stats directory", () => {
		expect(STATS_DIR.replace(/\\/g, "/")).toBe("C:/model-stats-test-agent/model-stats");
		expect(DATA_PATH.replace(/\\/g, "/")).toBe("C:/model-stats-test-agent/model-stats/data.json");
		expect(ERROR_LOG_PATH.replace(/\\/g, "/")).toBe("C:/model-stats-test-agent/model-stats/error.log");
		expect(LOCK_PATH.replace(/\\/g, "/")).toBe("C:/model-stats-test-agent/model-stats/.lock");
	});
});
