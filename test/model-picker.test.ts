import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	DynamicBorder: class {
		constructor(private readonly color: (value: string) => string) {}
		render() { return [this.color("")]; }
		invalidate() {}
	},
}));
vi.mock("@earendil-works/pi-tui", () => ({
	Input: class {
		focused = false;
		private value = "";
		onSubmit?: (value: string) => void;
		onEscape?: () => void;
		getValue() { return this.value; }
		setValue(value: string) { this.value = value; }
		handleInput(data: string) { if (data.length === 1 && data >= " ") this.value += data; }
		render() { return [this.value]; }
		invalidate() {}
	},
	fuzzyFilter: (items: any[], query: string, getText: (item: any) => string) => items.filter((item) => getText(item).toLowerCase().includes(query.toLowerCase())),
	truncateToWidth: (value: string, width: number) => value.slice(0, Math.max(0, width)),
	visibleWidth: (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "").length,
}));
vi.mock("../src/storage.js", () => ({}));

import { showModelPicker } from "../src/model-picker.js";
import type { ModelLike } from "../src/types.js";

const model = (provider: string, id: string): ModelLike => ({ provider, id, api: "openai-completions", baseUrl: `https://${provider}.test/v1` });

const keybindings = { matches: (data: string, key: string) => (key === "tui.select.down" && data === "down") || (key === "tui.select.up" && data === "up") || (key === "tui.select.confirm" && data === "enter") || (key === "tui.select.cancel" && data === "escape") || (key === "tui.input.tab" && data === "tab") };
const theme = { fg: (_kind: string, value: string) => value, bold: (value: string) => value };
function pickerContext(models: ModelLike[], custom: (factory: any) => Promise<unknown>) {
	return { mode: "tui", model: models[0], modelRegistry: { getAvailable: () => models, getError: () => undefined, refresh: async () => ({ aborted: false, errors: new Map() }) }, scopedModels: [], ui: { custom } };
}

describe("model picker runtime boundary", () => {
	it("reports non-TUI mode and cancellation without selecting a model", async () => {
		const notify = vi.fn();
		expect(await showModelPicker({ mode: "headless", ui: { notify } } as any, {} as any)).toBeNull();
		expect(notify).toHaveBeenCalledWith("/model-stats 仅在 TUI 模式可用", "warning");
		const first = model("provider-a", "model-a");
		let component: any;
		let finish!: (value: ModelLike | null) => void;
		const selected = new Promise<ModelLike | null>((resolve) => { finish = resolve; });
		const ctx = pickerContext([first], async (factory) => { component = factory({ requestRender() {} }, theme, keybindings, finish); return selected; });
		const promise = showModelPicker(ctx as any, {} as any);
		await new Promise((resolve) => setTimeout(resolve, 0));
		component.handleInput("escape");
		expect(await promise).toBeNull();
	});

	it.each([
		["aborted", { aborted: true, errors: new Map() }, "Model refresh timed out; showing cached models."],
		["catalog errors", { aborted: false, errors: new Map([["provider-a", new Error("offline")]]) }, "Could not refresh provider-a; showing cached models."],
	])("shows cached models after refresh %s", async (_name, result, expected) => {
		const cached = model("provider-a", "cached-model");
		let component: any;
		let finish!: (value: ModelLike | null) => void;
		const selected = new Promise<ModelLike | null>((resolve) => { finish = resolve; });
		const ctx = pickerContext([cached], async (factory) => { component = factory({ requestRender() {} }, theme, keybindings, finish); return selected; });
		ctx.modelRegistry.refresh = async () => result;
		const promise = showModelPicker(ctx as any, { getSummary: () => ({ todaySuccesses: 0, todayAttempts: 0, weekSuccesses: 0, weekAttempts: 0 }) } as any);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(component.render(80).join("\\n")).toContain(expected);
		expect(component.render(80).join("\\n")).toContain("cached-model");
		component.handleInput("escape");
		expect(await promise).toBeNull();
	});

	it("reports refresh exceptions and keeps the cached model selectable", async () => {
		const cached = model("provider-a", "cached-model");
		let component: any;
		let finish!: (value: ModelLike | null) => void;
		const selected = new Promise<ModelLike | null>((resolve) => { finish = resolve; });
		const ctx = pickerContext([cached], async (factory) => { component = factory({ requestRender() {} }, theme, keybindings, finish); return selected; });
		ctx.modelRegistry.refresh = async () => { throw new Error("offline"); };
		const promise = showModelPicker(ctx as any, { getSummary: () => ({ todaySuccesses: 0, todayAttempts: 0, weekSuccesses: 0, weekAttempts: 0 }) } as any);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(component.render(80).join("\\n")).toContain("Could not refresh model catalogs: offline");
		component.handleInput("enter");
		expect(await promise).toEqual(cached);
	});

	it("keeps statistics visible in narrow rows and selects through the public callback", async () => {
		const first = model("provider-a", "model-a");
		const second = model("provider-b", "model-b");
		let component: any;
		let finish!: (value: ModelLike | null) => void;
		const selected = new Promise<ModelLike | null>((resolve) => { finish = resolve; });
		const ctx = {
			mode: "tui",
			model: first,
			modelRegistry: { getAvailable: () => [first, second], getError: () => undefined, refresh: async () => ({ aborted: false, errors: new Map() }) },
			scopedModels: [],
			ui: {
				custom: async (factory: any) => {
					component = factory(
						{ requestRender() {} },
						{ fg: (_kind: string, value: string) => value, bold: (value: string) => value },
						keybindings,
						finish,
					);
					return selected;
				},
			},
		};
		const store = { getSummary: (candidate: ModelLike) => candidate.id === second.id ? { todaySuccesses: 2, todayAttempts: 3, weekSuccesses: 3, weekAttempts: 4, firstByteP50: 1200, firstByteP90: 2400, weekTps: 40.2 } : { todaySuccesses: 0, todayAttempts: 0, weekSuccesses: 0, weekAttempts: 0 } };
		const pickerPromise = showModelPicker(ctx as any, store as any);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const narrow = component.render(28).join("\n");
		expect(narrow).toContain("今2/3");
		expect(narrow).toContain("7日3/4");
		expect(narrow).toContain("1.2s/2.4s");
		expect(narrow).toContain("40.2t/s");
		expect(narrow.split("\n").every((line: string) => line.length <= 28)).toBe(true);
		component.handleInput("down");
		component.handleInput("enter");
		expect(await pickerPromise).toEqual(second);
	});
});
