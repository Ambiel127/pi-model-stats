import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), collect: vi.fn(), pick: vi.fn() }));
vi.mock("../src/storage.js", () => ({ StatsStore: { create: mocks.create } }));
vi.mock("../src/collector.js", () => ({ createCollector: mocks.collect }));
vi.mock("../src/model-picker.js", () => ({ showModelPicker: mocks.pick }));

import modelStats from "../src/index.js";

function extension() {
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const pi = {
		setModel: vi.fn(async () => true),
		registerCommand: vi.fn((name: string, value: any) => commands.set(name, value)),
		registerShortcut: vi.fn((key: string, value: any) => shortcuts.set(key, value)),
	};
	return { pi, commands, shortcuts };
}

describe("extension entrypoint", () => {
	it("initializes one store and registers the command and shortcut", async () => {
		const store = {};
		mocks.create.mockResolvedValue(store);
		const { pi, commands, shortcuts } = extension();
		await modelStats(pi as any);
		expect(mocks.create).toHaveBeenCalledOnce();
		expect(mocks.collect).toHaveBeenCalledWith(pi, store);
		expect(commands.has("model-stats")).toBe(true);
		expect(shortcuts.has("ctrl+alt+l")).toBe(true);
	});

	it("sets the selected model and reports missing API credentials", async () => {
		const model = { provider: "p", id: "m" };
		mocks.pick.mockResolvedValue(model);
		const store = {};
		mocks.create.mockResolvedValue(store);
		const { pi, commands } = extension();
		pi.setModel.mockResolvedValueOnce(false);
		await modelStats(pi as any);
		const ctx = { ui: { notify: vi.fn() } };
		await commands.get("model-stats").handler("", ctx);
		expect(pi.setModel).toHaveBeenCalledWith(model);
		expect(ctx.ui.notify).toHaveBeenCalledWith("No API key available for this model", "error");
	});

	it("does not switch models when picker is cancelled", async () => {
		mocks.pick.mockResolvedValue(null);
		mocks.create.mockResolvedValue({});
		const { pi, shortcuts } = extension();
		await modelStats(pi as any);
		await shortcuts.get("ctrl+alt+l").handler({});
		expect(pi.setModel).not.toHaveBeenCalled();
	});
});
