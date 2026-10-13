import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatStatsFields } from "./metrics.js";
import { StatsStore } from "./storage.js";
import type { ModelLike } from "./types.js";

type AnyModel = Model<any> & ModelLike;
type ScopedModel = { model: AnyModel; thinkingLevel?: string };

type ModelRow = { model: AnyModel };

function sameModel(left: AnyModel | undefined, right: AnyModel | undefined): boolean {
	return Boolean(left && right && left.provider === right.provider && left.id === right.id);
}

const FIELD_SEPARATOR = " · ";
const FIELD_SEPARATOR_WIDTH = visibleWidth(FIELD_SEPARATOR);
const FIELD_ELLIPSIS = " · …";
const FIELD_ELLIPSIS_WIDTH = visibleWidth(FIELD_ELLIPSIS);
const MIN_NAME_WIDTH = 12;
const MIN_SUFFIX_WIDTH = 12;

type RenderRow = { left: string; fields: string[]; isSelected: boolean };

/** 名字预算：完整容纳可见行里最长的名字，但最少留 MIN_SUFFIX_WIDTH 列给统计。 */
function resolveNameBudget(rows: readonly RenderRow[], width: number): number {
	const longest = rows.reduce((max, row) => Math.max(max, visibleWidth(row.left)), 0);
	return Math.max(MIN_NAME_WIDTH, Math.min(longest, width - MIN_SUFFIX_WIDTH));
}

/** 按可见宽度补齐字段。字段当前不含 ANSI，但用 visibleWidth 而非 length，以免将来加样式时错位。 */
function padField(field: string, width: number): string {
	return field + " ".repeat(Math.max(0, width - visibleWidth(field)));
}

/** 每个字段列在同屏所有行中的最大可见宽度。补齐后各行的同一字段才真正纵向对齐，而不只是首列对齐。 */
function resolveFieldWidths(rows: readonly RenderRow[]): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		row.fields.forEach((field, index) => { widths[index] = Math.max(widths[index] ?? 0, visibleWidth(field)); });
	}
	return widths;
}

/** 取所有可见行都容纳得下的最大字段数（按补齐后的列宽计算），保证同屏字段数一致且列对齐。 */
function resolveFieldCount(rows: readonly RenderRow[], widths: readonly number[], budget: number): number {
	const candidates = rows.filter((row) => row.fields.length > 0);
	if (candidates.length === 0) return 0;
	const max = Math.max(...candidates.map((row) => row.fields.length));
	let count = 0;
	for (let n = 1; n <= max; n++) {
		// 最宽那一行的末列刚好无需补齐，所以 sum(widths[0..n-1]) 就是实际占宽，不是高估。
		const needed = widths.slice(0, n).reduce((sum, width) => sum + width, 0) + (n - 1) * FIELD_SEPARATOR_WIDTH + (n < max ? FIELD_ELLIPSIS_WIDTH : 0);
		if (needed > budget) break;
		count = n;
	}
	return count;
}

export async function showModelPicker(ctx: ExtensionContext, store: StatsStore): Promise<AnyModel | null> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/model-stats 仅在 TUI 模式可用", "warning");
		return null;
	}
	return ctx.ui.custom<AnyModel | null>((tui, theme, keybindings, done) => {
		const picker = new ModelStatsPicker(
			tui,
			theme,
			keybindings,
			ctx.modelRegistry,
			ctx.model as AnyModel | undefined,
			ctx.scopedModels as readonly ScopedModel[],
			store,
			done,
		);
		return picker;
	});
}

class ModelStatsPicker implements Component {
	private _focused = false;
	private readonly searchInput = new Input();
	private readonly topBorder: DynamicBorder;
	private readonly bottomBorder: DynamicBorder;
	private allModels: ModelRow[] = [];
	private scopedModels: ModelRow[] = [];
	private activeModels: ModelRow[] = [];
	private filteredModels: ModelRow[] = [];
	private selectedIndex = 0;
	private scope: "all" | "scoped";
	private errorMessage = "";
	private refreshMessage = "Refreshing model catalogs…";
	private refreshSuccess = false;
	private readonly refreshController = new AbortController();
	private readonly refreshTimeout: ReturnType<typeof setTimeout>;
	private closed = false;
	private readonly scopedModelItems: readonly ScopedModel[];

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly registry: ExtensionContext["modelRegistry"],
		private readonly currentModel: AnyModel | undefined,
		scopedModels: readonly ScopedModel[],
		private readonly store: StatsStore,
		private readonly done: (model: AnyModel | null) => void,
	) {
		this.scopedModelItems = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.setSnapshot(this.registry.getAvailable(), scopedModels);
		this.refreshTimeout = setTimeout(() => this.refreshController.abort(), 15_000);
		void this.refreshModels();
	}

	private setSnapshot(models: readonly AnyModel[], scopedModels: readonly ScopedModel[] = []): void {
		this.allModels = [...models]
			.sort((left, right) => {
				const leftCurrent = sameModel(this.currentModel, left) ? 0 : 1;
				const rightCurrent = sameModel(this.currentModel, right) ? 0 : 1;
				return leftCurrent - rightCurrent || left.provider.localeCompare(right.provider);
			})
			.map((model) => ({ model }));
		if (scopedModels.length > 0) {
			const available = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
			this.scopedModels = scopedModels.map((entry) => ({ model: available.get(`${entry.model.provider}/${entry.model.id}`) ?? entry.model }));
		}
		this.activeModels = this.scope === "scoped" ? this.scopedModels : this.allModels;
		const currentIndex = this.activeModels.findIndex(({ model }) => sameModel(this.currentModel, model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		const query = this.searchInput.getValue();
		this.applyFilter(query, query.length > 0);
	}

	private async refreshModels(): Promise<void> {
		try {
			const result = await this.registry.refresh({ signal: this.refreshController.signal });
			if (this.closed) return;
			if (result.aborted || this.refreshController.signal.aborted) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
				this.refreshMessage = "";
			} else if (result.errors && result.errors.size > 0) {
				this.refreshMessage = "";
				this.errorMessage = result.errors.size === 1
					? `Could not refresh ${result.errors.keys().next().value}; showing cached models.`
					: `Could not refresh ${result.errors.size} model catalogs; showing cached models.`;
			} else {
				this.errorMessage = this.registry.getError() ?? "";
				if (!this.errorMessage) {
					this.refreshMessage = "Model catalogs refreshed.";
					this.refreshSuccess = true;
				}
			}
			this.setSnapshot(this.registry.getAvailable(), this.scopedModelItems);
		} catch (error) {
			if (!this.closed) {
				this.refreshMessage = "";
				this.errorMessage = this.refreshController.signal.aborted
					? "Model refresh timed out; showing cached models."
					: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			}
		} finally {
			clearTimeout(this.refreshTimeout);
			if (!this.closed) this.tui.requestRender();
		}
	}

	private applyFilter(query: string, resetSelection: boolean): void {
		this.filteredModels = query
			? fuzzyFilter(this.activeModels, query, ({ model }) => `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${model.name ? ` ${model.name}` : ""}`)
			: [...this.activeModels];
		if (resetSelection) this.selectedIndex = 0;
		else this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private toggleScope(): void {
		if (this.scopedModels.length === 0) return;
		this.scope = this.scope === "all" ? "scoped" : "all";
		this.activeModels = this.scope === "scoped" ? this.scopedModels : this.allModels;
		const currentIndex = this.activeModels.findIndex(({ model }) => sameModel(this.currentModel, model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		const query = this.searchInput.getValue();
		this.applyFilter(query, query.length > 0);
	}

	private selectCurrent(): void {
		const row = this.filteredModels[this.selectedIndex];
		if (!row) return;
		this.closed = true;
		this.refreshController.abort();
		this.done(row.model);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.toggleScope();
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.filteredModels.length > 0) this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.filteredModels.length > 0) this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.selectCurrent();
			return;
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.closed = true;
			this.refreshController.abort();
			this.done(null);
			return;
		} else {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue(), true);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [...this.topBorder.render(width), truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Stats")), width, "")];
		if (this.scopedModels.length > 0) {
			const all = this.scope === "all" ? this.theme.fg("accent", "all") : this.theme.fg("muted", "all");
			const scoped = this.scope === "scoped" ? this.theme.fg("accent", "scoped") : this.theme.fg("muted", "scoped");
			lines.push(truncateToWidth(`${this.theme.fg("muted", "Scope: ")}${all}${this.theme.fg("muted", " | ")}${scoped}  ${this.theme.fg("dim", "Tab 切换")}`, width, ""));
		}
		const searchLines = this.searchInput.render(Math.max(1, width - 8));
		lines.push(truncateToWidth(`${this.theme.fg("muted", "搜索: ")}${searchLines[0] ?? ""}`, width, ""));
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filteredModels.length);
		const rows: RenderRow[] = [];
		for (let index = start; index < end; index++) {
			const row = this.filteredModels[index]!;
			// 与 pi 原生 model-selector 一致：标记置于名字前，且恒定占 2 列以保证 id 纵向对齐。
			const currentMarker = sameModel(this.currentModel, row.model) ? "✓ " : "  ";
			rows.push({
				left: `${index === this.selectedIndex ? "→ " : "  "}${currentMarker}${row.model.id} [${row.model.provider}]`,
				fields: formatStatsFields(this.store.getSummary(row.model)),
				isSelected: index === this.selectedIndex,
			});
		}
		const nameBudget = resolveNameBudget(rows, width);
		const fieldWidths = resolveFieldWidths(rows);
		const fieldCount = resolveFieldCount(rows, fieldWidths, Math.max(0, width - nameBudget - 2));
		for (const row of rows) {
			const truncated = row.fields.length > fieldCount;
			// 逐列补齐后再拼接；末列的尾随空格无意义，裁掉以免白占宽度。详情行不补齐（单行无需对齐）。
			const shown = row.fields.slice(0, fieldCount).map((field, index) => padField(field, fieldWidths[index] ?? 0));
			const suffix = shown.length === 0 ? "" : shown.join(FIELD_SEPARATOR).replace(/\s+$/, "") + (truncated ? FIELD_ELLIPSIS : "");
			const leftText = truncateToWidth(row.left, suffix ? nameBudget : width, "");
			const styledLeft = row.isSelected ? this.theme.fg("accent", leftText) : leftText;
			const pad = suffix ? `${" ".repeat(Math.max(0, nameBudget - visibleWidth(leftText)))}  ` : "";
			lines.push(truncateToWidth(`${styledLeft}${pad}${suffix ? this.theme.fg("muted", suffix) : ""}`, width, ""));
			if (row.isSelected && truncated) {
				// 6 空格缩进：模型行前缀最多占 4 列（光标 2 + 当前标记 2），详情行需与之区分。
				for (const detail of wrapTextWithAnsi(row.fields.join(FIELD_SEPARATOR), Math.max(1, width - 6))) {
					lines.push(truncateToWidth(this.theme.fg("dim", `      ${detail}`), width, ""));
				}
			}
		}
		if (this.filteredModels.length === 0) lines.push(truncateToWidth(this.theme.fg("muted", "  No matching models"), width, ""));
		else lines.push(truncateToWidth(this.theme.fg("dim", `  ${this.selectedIndex + 1}/${this.filteredModels.length}`), width, ""));
		if (this.errorMessage) lines.push(truncateToWidth(this.theme.fg("error", `  ${this.errorMessage}`), width, ""));
		if (this.refreshMessage) lines.push(truncateToWidth(this.theme.fg(this.refreshSuccess ? "success" : "muted", `  ${this.refreshMessage}`), width, ""));
		lines.push(...this.bottomBorder.render(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.topBorder.invalidate();
		this.bottomBorder.invalidate();
		this.searchInput.invalidate();
	}

	dispose(): void {
		this.closed = true;
		this.refreshController.abort();
		clearTimeout(this.refreshTimeout);
	}
}
