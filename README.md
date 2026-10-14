# ▦ pi-model-stats

**[Pi](https://github.com/earendil-works/pi) 扩展：根据实际调用表现比较模型延迟与吞吐，帮助你选择合适的模型；不发送模型探测请求。**

[English](README.en.md) · 简体中文

[![pi](https://img.shields.io/badge/pi-package-7c3aed?style=flat-square)](https://pi.dev/packages/pi-model-stats) [![npm](https://img.shields.io/npm/v/pi-model-stats?style=flat-square&color=blue)](https://www.npmjs.com/package/pi-model-stats) [![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](./LICENSE)

![pi-model-stats 模型选择器](https://raw.githubusercontent.com/Ambiel127/pi-model-stats/main/assets/model-stats.png)

*截图展示选择器界面；统计值来自本机实际观测的模型调用，无近 7 日数据时暂不显示。*

## 安装

```bash
# 单次试用（当次生效）
pi -e npm:pi-model-stats

# 长期安装（装完重启 Pi 或执行 /reload）
pi install npm:pi-model-stats
```

## 功能

- **被动采集** —— 只观察 provider 生命周期与 assistant 流事件，不发送探测请求，不改变请求参数或重试逻辑；仅统计扩展启用期间的调用，不回溯此前请求。
- **统计选择器** —— `/model-stats` 或 `Ctrl+Alt+L` 打开模型选择器，有近 7 日数据的模型在行内展示统计。
- **延迟与吞吐** —— `1d`/`7d` 成功数与有效请求数、首字延迟 `P50`/`P90`、`7d` `TPS`。
- **自适应宽度** —— 窄终端按优先级从末尾丢弃字段，并追加 `· …` 标记；选中行在下方展示完整字段。
- **隔离与保留** —— 按 provider、模型 ID 与非敏感配置指纹隔离；按日聚合，保留最近 30 天。
- **隐私与轻量** —— 不保存请求/响应内容或 API key；无运行时第三方依赖。

选择器支持搜索、上下移动、确认与取消，打开时尝试刷新模型目录（15 秒超时），失败或超时则显示缓存模型。若配置了 scoped models（`/scoped-models` 的 `Ctrl+P` 轮换列表），可用 Tab 在 all/scoped 间切换，默认进入 scoped。仅 TUI 模式。

`/model`、`Ctrl+L` 和 Pi 原生模型选择器不受影响。选择后通过公开 API `pi.setModel()` 切换当前 session 模型。

## 指标口径

- **1d / 7d** —— 本地日历日累计（`1d` 是 `7d` 的子集，非滚动窗口）。分子为成功数，分母为成功数加 provider 失败数；用户取消和请求被拒绝不计入分母。
- **首字延迟 P50/P90** —— 请求开始到首个文本、思考或工具调用流事件，反映首个可见内容事件，不是网络层首字节计时。统计窗口同 `7d`。分位数由有界加权质心摘要（最多 300 个质心）计算，是**近似值**，精度随输入分布和跨日合并而变。
- **7d TPS** —— 仅取成功请求中有正输出 token 且观测到正生成时长的样本，按总输出 token ÷ 总生成秒数计算，而非逐请求求平均。

统计窗口按运行机器的**本地时区**切分。Pi 公开 API 不提供贯穿 provider 事件与 assistant 消息的稳定请求 ID，扩展只能按模型身份保守关联：无法唯一归属的流事件会跳过，统计可能漏记或错配，不保证覆盖每个请求。

## 数据与隐私

不保存完整请求/响应内容或 API key。统计数据默认写入 Pi agent 全局目录，可用 `PI_MODEL_STATS_DIR` 覆盖：

```text
~/.pi/agent/model-stats/data.json
~/.pi/agent/model-stats/error.log
```

数据按日聚合并保留最近 30 天。扩展不提供清空统计的命令；需要重置时直接删除 `data.json`。

`error.log`（约 1 MB 上限）仅记录存储诊断，不是通用异常日志；内容可能包含异常堆栈和本机路径，使用或分享前请先检查并按需脱敏。

实现细节：`data.json` 使用 schema v4，按模型身份分桶记录结果计数、首字延迟摘要与 TPS 聚合，并保存少量近期结果状态（最近 20 条结果标记、连续失败次数、最近成功/失败时间；当前版本仅存储不展示）。数据通过临时文件原子替换，并用目录锁协调并发；无法解析时备份为 `data.json.corrupt-<时间戳>`，最多保留 5 个损坏备份。

## 更新

```bash
pi update npm:pi-model-stats
```

## 贡献

欢迎提交 Issue 和 Pull Request。

## 许可

[MIT](./LICENSE) © 2026 matianhao
