# ▦ pi-model-stats

**A [Pi](https://github.com/earendil-works/pi) extension that compares model latency and throughput from real usage to help you choose the right model—without sending model probe requests.**

English · [简体中文](README.md)

[![pi](https://img.shields.io/badge/pi-package-7c3aed?style=flat-square)](https://pi.dev/packages/pi-model-stats) [![npm](https://img.shields.io/npm/v/pi-model-stats?style=flat-square&color=blue)](https://www.npmjs.com/package/pi-model-stats) [![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](./LICENSE)

![pi-model-stats model picker](https://raw.githubusercontent.com/Ambiel127/pi-model-stats/main/assets/model-stats.png)

*The screenshot shows the picker UI. Statistics come from observed model calls on your machine; models without data from the last 7 days show no statistics.*

## Install

```bash
# Try for one session (effective for this run only)
pi -e npm:pi-model-stats

# Install persistently (restart Pi or run /reload after installation)
pi install npm:pi-model-stats
```

## Features

- **Passive collection** — Observes provider lifecycle and assistant stream events only. It sends no model probes, does not change request parameters or retry behavior, and records calls only while the extension is enabled; earlier requests are not backfilled.
- **Stats-enhanced model picker** — Run `/model-stats` or press `Ctrl+Alt+L` to open the picker. Models with data from the last 7 days show inline statistics.
- **Latency and throughput** — Successful and eligible request counts for `1d`/`7d`, first-visible-event latency `P50`/`P90`, and `7d` `TPS`.
- **Adaptive layout** — On narrow terminals, lower-priority fields are dropped from the end and marked with `· …`; the selected model shows all fields below its row.
- **Isolation and retention** — Statistics are separated by provider, model ID, and a non-sensitive configuration fingerprint; daily aggregates are retained for 30 days.
- **Privacy and lightweight** — Does not store full request/response content or API keys. No runtime third-party dependencies.

The picker supports search, navigation, selection, and cancellation. It attempts to refresh model catalogs when opened (15-second timeout); if refresh fails or times out, cached models are shown. If scoped models are configured (the `/scoped-models` list used by `Ctrl+P` cycling), press `Tab` to switch between `all` and `scoped`; `scoped` is selected by default. TUI mode only.

`/model`, `Ctrl+L`, and Pi's native model picker are unaffected. Selecting a model uses the public `pi.setModel()` API to switch the current session model.

## Metric definitions

- **`1d` / `7d`** — Local calendar-day totals (`1d` is part of `7d`; these are not rolling windows). The numerator is successes; the denominator is successes plus provider failures. User cancellations and rejected requests are excluded.
- **First-event latency `P50`/`P90`** — Time from request start to the first text, thinking, or tool-call stream event. This measures the first visible content event, not network-level time to first byte. The window is `7d`. Percentiles are **approximate**, computed from a bounded weighted-centroid digest with at most 300 centroids; accuracy depends on the input distribution and cross-day merges.
- **`7d` TPS** — Calculated as total output tokens divided by total generation time, using only successful requests with positive output-token counts and observed positive generation time. It is not the average of per-request TPS.

Windows use the local time zone of the machine running Pi. Pi's public API does not expose a stable request ID spanning provider events and assistant messages, so events are conservatively correlated by model identity. Ambiguous stream events are skipped; statistics may be missed or misattributed and are not guaranteed to cover every request.

## Data and privacy

Full request/response content and API keys are not stored. By default, statistics are written to Pi's global agent directory; set `PI_MODEL_STATS_DIR` to override it:

```text
~/.pi/agent/model-stats/data.json
~/.pi/agent/model-stats/error.log
```

Daily aggregates are retained for 30 days. There is no command to clear statistics; delete `data.json` to reset them.

`error.log` (limited to about 1 MB) contains storage diagnostics only, not general extension errors. It may include exception stack traces and local paths; review and redact it before sharing.

Implementation details: `data.json` uses schema v4 and stores per-model result counts, first-event latency digests, and TPS aggregates, plus a small amount of recent status (the last 20 result markers, consecutive failure count, and timestamps of the latest success/failure; currently stored but not displayed). Writes use a temporary file and atomic replacement, with a directory lock for coordination. Unparseable data is backed up as `data.json.corrupt-<timestamp>`; up to five corrupt backups are retained.

## Update

```bash
pi update npm:pi-model-stats
```

## Contributing

Issues and pull requests are welcome.

## License

[MIT](./LICENSE) © 2026 matianhao
