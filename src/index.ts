import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCollector } from "./collector.js";
import { showModelPicker } from "./model-picker.js";
import { StatsStore } from "./storage.js";

export default async function modelStats(pi: ExtensionAPI): Promise<void> {
	const store = await StatsStore.create();
	createCollector(pi, store);

	const openPicker = async (ctx: ExtensionContext) => {
		const model = await showModelPicker(ctx, store);
		if (!model) return;
		const selected = await pi.setModel(model);
		if (!selected) ctx.ui.notify("No API key available for this model", "error");
	};

	pi.registerCommand("model-stats", {
		description: "Open model selector with passive provider statistics",
		handler: async (_args, ctx) => openPicker(ctx),
	});

	pi.registerShortcut("ctrl+alt+l", {
		description: "Open model-stats model selector",
		handler: openPicker,
	});
}
