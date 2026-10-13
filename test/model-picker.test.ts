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
	wrapTextWithAnsi: (value: string, width: number) => {
		const size = Math.max(1, width);
		const lines: string[] = [];
		let current = "";
		for (const word of value.split(" ")) {
			const candidate = current ? `${current} ${word}` : word;
			if (current && candidate.length > size) { lines.push(current); current = word; } else { current = candidate; }
		}
		if (current) lines.push(current);
		return lines.length === 0 ? [""] : lines;
	},
}));
vi.mock("../src/storage.js", () => ({}));

import { showModelPicker } from "../src/model-picker.js";
import type { ModelLike } from "../src/types.js";

const model = (provider: string, id: string): ModelLike => ({ provider, id, api: "openai-completions", baseUrl: `https://${provider}.test/v1` });

const keybindings = { matches: (data: string, key: string) => (key === "tui.select.down" && data === "down") || (key === "tui.select.up" && data === "up") || (key === "tui.select.confirm" && data === "enter") || (key === "tui.select.cancel" && data === "escape") || (key === "tui.input.tab" && data === "tab"), getKeys: (id: string) => (id === "tui.select.confirm" ? ["enter"] : id === "tui.select.cancel" ? ["escape"] : id === "tui.input.tab" ? ["tab"] : []) };
const theme = { fg: (_kind: string, value: string) => value, bold: (value: string) => value };
/** 详情行以 6 空格缩进（模型行前缀最多 4 列）；拼回换行处丢失的分隔空格，还原成完整内联文本。 */
const DETAIL_INDENT = "      ";
const detailOf = (lines: string[]) => lines.filter((line) => line.startsWith(DETAIL_INDENT)).map((line) => line.trim()).join(" ");
/** 只取模型行：含统计且不是详情行。 */
const modelRows = (lines: string[]) => lines.filter((line) => line.includes("1d ") && !line.startsWith(DETAIL_INDENT));
function pickerContext(models: ModelLike[], custom: (factory: any) => Promise<unknown>) {
	return { mode: "tui", model: models[0], modelRegistry: { getAvailable: () => models, getError: () => undefined, refresh: async () => ({ aborted: false, errors: new Map() }) }, scopedModels: [], ui: { custom } };
}

describe("model picker runtime boundary", () => {
	it("reports non-TUI mode and cancellation without selecting a model", async () => {
		const notify = vi.fn();
		expect(await showModelPicker({ mode: "headless", ui: { notify } } as any, {} as any)).toBeNull();
		expect(notify).toHaveBeenCalledWith("/model-stats is only available in TUI mode", "warning");
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

	it("shows the selected model's display name and falls back to its id", async () => {
		const named: ModelLike = { ...model("provider-a", "model-a"), name: "Claude Sonnet 4.5" };
		const unnamed = model("provider-b", "model-b");
		let component: any;
		let finish!: (value: ModelLike | null) => void;
		const selected = new Promise<ModelLike | null>((resolve) => { finish = resolve; });
		const ctx = pickerContext([named, unnamed], async (factory) => { component = factory({ requestRender() {} }, theme, keybindings, finish); return selected; });
		const promise = showModelPicker(ctx as any, { getSummary: () => ({ todaySuccesses: 7, todayAttempts: 7, weekSuccesses: 7, weekAttempts: 7, firstByteP50: 3200, firstByteP90: 4100, weekTps: 67.7 }) } as any);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const nameLine = (lines: string[]) => lines.find((line) => line.includes("Model Name:"));
		expect(nameLine(component.render(80))).toBe("  Model Name: Claude Sonnet 4.5");
		component.handleInput("down");
		expect(nameLine(component.render(80))).toBe("  Model Name: model-b");
		finish(null);
		await promise;
	});

	it("truncates statistics in narrow rows, expands them for the selection, and selects through the public callback", async () => {
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
		const narrow = component.render(28);
		expect(narrow.join("\n")).toContain("1d 2/3 · …");
		expect(narrow.join("\n")).not.toContain("TPS");
		expect(detailOf(narrow)).toBe("");
		expect(narrow.every((line: string) => line.length <= 28)).toBe(true);

		component.handleInput("down");
		const expanded = component.render(28);
		expect(detailOf(expanded)).toBe("1d 2/3 · 7d 3/4 · P50 1.2s · P90 2.4s · TPS 40.2");
		expect(expanded.every((line: string) => line.length <= 28)).toBe(true);

		const wide = component.render(80);
		expect(detailOf(wide)).toBe("");
		expect(wide.join("\n")).toContain("1d 2/3 · 7d 3/4 · P50 1.2s · P90 2.4s · TPS 40.2");
		expect(wide.join("\n")).not.toContain("…");

		component.handleInput("enter");
		expect(await pickerPromise).toEqual(second);
	});

	it("aligns statistics into a single column across rows", async () => {
		const models = [model("provider-a", "short"), model("provider-b", "a-much-longer-model-id"), model("provider-c", "mid-name")];
		let component: any;
		let finish!: (value: ModelLike | null) => void;
		const selected = new Promise<ModelLike | null>((resolve) => { finish = resolve; });
		const ctx = pickerContext(models, async (factory) => { component = factory({ requestRender() {} }, theme, keybindings, finish); return selected; });
		const store = { getSummary: () => ({ todaySuccesses: 7, todayAttempts: 7, weekSuccesses: 3, weekAttempts: 4, firstByteP50: 3200, firstByteP90: 4100, weekTps: 67.7 }) };
		const promise = showModelPicker(ctx as any, store as any);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = component.render(100).filter((line: string) => line.includes("1d 7/7"));
		expect(rows.length).toBe(3);
		expect(new Set(rows.map((line: string) => line.indexOf("1d 7/7"))).size).toBe(1);
		component.handleInput("escape");
		expect(await promise).toBeNull();
	});

	it("aligns every statistics column, not just the first", async () => {
		const models = [model("provider-a", "aaa"), model("provider-b", "bbb")];
		let component: any;
		let finish!: (value: ModelLike | null) => void;
		const selected = new Promise<ModelLike | null>((resolve) => { finish = resolve; });
		const ctx = pickerContext(models, async (factory) => { component = factory({ requestRender() {} }, theme, keybindings, finish); return selected; });
		// 两行的 day / week 字段宽度不同（6 列 vs 10 列）；不逐列补齐时后续字段的起始列会错开 4 列。
		const store = { getSummary: (target: ModelLike) => (target.id === "aaa"
			? { todaySuccesses: 7, todayAttempts: 7, weekSuccesses: 3, weekAttempts: 4, firstByteP50: 3200, firstByteP90: 4100, weekTps: 67.7 }
			: { todaySuccesses: 123, todayAttempts: 456, weekSuccesses: 300, weekAttempts: 400, firstByteP50: 9900, firstByteP90: 88000, weekTps: 5 }) };
		const promise = showModelPicker(ctx as any, store as any);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = modelRows(component.render(120));
		expect(rows.length).toBe(2);
		for (const column of ["day", "week", "P50", "P90", "TPS"]) {
			const positions = new Set(rows.map((line: string) => line.indexOf(column)));
			expect(positions.size, column).toBe(1);
		}
		component.handleInput("escape");
		expect(await promise).toBeNull();
	});

	it("keeps the current-model marker in front so it survives narrow widths", async () => {
		const models = [model("provider-a", "claude-sonnet-4-5"), model("provider-b", "gpt-5.2")];
		let component: any;
		let finish!: (value: ModelLike | null) => void;
		const selected = new Promise<ModelLike | null>((resolve) => { finish = resolve; });
		const ctx = pickerContext(models, async (factory) => { component = factory({ requestRender() {} }, theme, keybindings, finish); return selected; });
		const store = { getSummary: () => ({ todaySuccesses: 7, todayAttempts: 7, weekSuccesses: 42, weekAttempts: 45, firstByteP50: 3200, firstByteP90: 4100, weekTps: 67.7 }) };
		const promise = showModelPicker(ctx as any, store as any);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 名字已被截到只剩前缀，标记仍在第 2 列；id 起始列与非当前行一致（标记恒占 2 列）
		const narrow = modelRows(component.render(34));
		expect(narrow.length).toBe(2);
		expect(narrow[0]!.startsWith("→ ✓ ")).toBe(true);
		expect(narrow[1]!.indexOf("✓")).toBe(-1);
		// 标记恒占 2 列，所以当前行与非当前行的 id 起始列一致
		expect(narrow[0]!.indexOf("claude")).toBe(4);
		expect(narrow[1]!.indexOf("gpt")).toBe(4);
		component.handleInput("escape");
		expect(await promise).toBeNull();
	});
});
