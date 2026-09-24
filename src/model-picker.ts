import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, truncateToWidth, visibleWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatAvailability, formatFirstByte } from "./metrics.js";
import { StatsStore } from "./storage.js";
import type { ModelLike } from "./types.js";

type AnyModel = Model<any> & ModelLike;
type ScopedModel = { model: AnyModel; thinkingLevel?: string };

type ModelRow = { model: AnyModel };

function sameModel(left: AnyModel | undefined, right: AnyModel | undefined): boolean {
	return Boolean(left && right && left.provider === right.provider && left.id === right.id);
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
		for (let index = start; index < end; index++) {
			const row = this.filteredModels[index]!;
			const isSelected = index === this.selectedIndex;
			const current = sameModel(this.currentModel, row.model) ? " ✓" : "";
			const summary = this.store.getSummary(row.model);
			const tps = summary.weekTps === undefined ? "TPS —" : `TPS ${summary.weekTps.toFixed(1)} t/s`;
			const fullSuffix = summary.weekAttempts > 0
				? `今日 ${formatAvailability(summary.todaySuccesses, summary.todayAttempts)} · 7日 ${formatAvailability(summary.weekSuccesses, summary.weekAttempts)} · P50 ${formatFirstByte(summary.firstByteP50).replace("首字 ", "")} · P90 ${formatFirstByte(summary.firstByteP90).replace("首字 ", "")} · ${tps}`
				: "";
			const compactSuffix = summary.weekAttempts > 0
				? `今${formatAvailability(summary.todaySuccesses, summary.todayAttempts)}·7日${formatAvailability(summary.weekSuccesses, summary.weekAttempts)}·${formatFirstByte(summary.firstByteP50).replace("首字 ", "")}/${formatFirstByte(summary.firstByteP90).replace("首字 ", "")}·${summary.weekTps === undefined ? "TPS —" : `${summary.weekTps.toFixed(1)}t/s`}`
				: "";
			const suffix = fullSuffix && visibleWidth(fullSuffix) + 2 <= width ? fullSuffix : compactSuffix;
			const prefix = isSelected ? "→ " : "  ";
			const left = `${prefix}${row.model.id} [${row.model.provider}]${current}`;
			const styledSuffix = suffix ? this.theme.fg("muted", suffix) : "";
			const suffixWidth = visibleWidth(styledSuffix);
			const leftWidth = suffix ? Math.max(0, width - suffixWidth - 2) : width;
			const leftText = truncateToWidth(left, leftWidth, "");
			const styledLeft = isSelected ? this.theme.fg("accent", leftText) : leftText;
			const separator = suffix && leftText.length > 0 ? "  " : "";
			lines.push(truncateToWidth(`${styledLeft}${separator}${styledSuffix}`, width, ""));
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
