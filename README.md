# pi-model-stats

Pi 扩展：在不主动发送探测请求的前提下，被动统计模型调用表现，并提供带统计信息的模型选择器。扩展只观察 Pi provider 生命周期及 assistant 流事件，不改变请求参数或重试逻辑。

## 功能概览

- `/model-stats`：打开模型选择器；`Ctrl+Alt+L`：快捷打开。
- 显示模型今日与近 7 日成功数/有效请求数、首字延迟 P50/P90，以及近 7 日 TPS（满足数据条件时）。
- 统计按 provider、模型 ID 和非敏感配置指纹隔离。
- 统计数据按日聚合并保留最近 30 天，另保存少量近期结果状态；不保存完整请求/响应内容或 API key。
- 不添加运行时第三方依赖。

`/model`、`Ctrl+L` 和 Pi 原生模型选择器不受影响。选择模型后通过公开 API `pi.setModel()` 切换当前 session 模型。

## 使用

要求 Pi `0.84.2` 及兼容的 Node.js 运行环境。可通过 npm 安装：

```bash
pi install npm:pi-model-stats
```

也可从源码目录显式加载扩展入口：

```bash
pi -e ./src/index.ts
```

在交互式 TUI 中执行 `/model-stats` 或按 `Ctrl+Alt+L`。选择器支持搜索、上下移动、确认选择和取消；存在 scoped models 时可用 Tab 切换 all/scoped。模型目录会尝试刷新，刷新失败或超时则显示缓存模型。该选择器只支持 TUI 模式。

## 数据采集与统计口径

### 被动采集

`src/collector.ts` 监听 provider headers/request/response、assistant `message_update`、`message_end` 和 session shutdown 等事件：

- 请求从可观察到的 provider 生命周期事件建立记录；同一逻辑请求的可观察重试不会简单地重复计为用户请求。
- 首字延迟从请求开始到首个文本、思考或工具调用流事件计算。它反映首个可见内容事件，不是网络层首字节计时。
- 成功、取消和错误由 stop reason、HTTP 状态及错误信息分类。错误分类用于聚合结果类别；原始请求及响应内容不写入统计文件。

Pi 公共 API 不提供贯穿 provider 请求事件与 assistant 消息事件的稳定请求 ID，也没有物理 retry attempt ID。扩展只能根据模型身份和可观察到的事件进行保守关联：若同模型存在多个候选请求，无法唯一确定归属的流事件（包括首字延迟）会跳过；最终结果仍可能按模型匹配到待处理请求，因此并发请求的归属不保证准确。测试中的交错事件用例只验证模拟顺序下的行为，不证明真实运行时始终能正确关联。因此统计可能漏记或错配，不保证覆盖每个请求，也不保证等于底层物理 HTTP 尝试数。

### 展示指标

- **今日 / 7日成功数/有效请求数**：分子为成功请求；分母为成功数加 provider 失败数。用户主动取消和请求被拒绝不计入分母。
- **首字 P50/P90**：对有首字延迟的观测值计算近似分位数；失败请求如果已经产生可见流事件，也可能贡献首字延迟。
- **7日 TPS**：仅累计成功请求中有正数输出 token usage、且观测到正生成时长的样本；按总输出 token 数除以总生成秒数计算，而不是对逐请求 TPS 求平均。历史数据没有相应字段时不会伪造 TPS。

统计窗口按 UTC 日计算。模型身份的配置指纹包括 API、规范化 base URL、兼容设置、采样参数、思考等级映射及筛选后的路由 header；敏感字段会从指纹输入中排除。

## 分位数摘要

`src/digest.ts` 实现无外部依赖、受 t-digest 启发的加权质心摘要。每个质心保存代表值和样本数；根据质心在分布中的位置限制可合并容量，让两端保留更多细节；超过上限时压缩，最多保留 300 个质心。每日写入摘要，查询跨日指标时合并每日摘要后计算分位数。

P50/P90 是近似值，精度受输入分布和摘要合并影响。验收测试以精确分位值为基准：P50、P90 的绝对误差应不超过 `max(10 ms, 精确分位值 × 5%)`。测试覆盖连续、偏斜/长尾、双峰、重复值、不同写入顺序及分日摘要合并等合成场景，并同时检查样本数、分位单调性和摘要上限。该标准是这些测试场景的验收目标，不构成对任意生产数据分布的数学保证；300 个质心是单日存储上限，不代表误差阈值。

## 文件与隐私

默认情况下，运行时数据写入 Pi agent 全局目录：

```text
~/.pi/agent/model-stats/data.json
~/.pi/agent/model-stats/error.log
```

`data.json` 使用 schema v4：按模型身份分桶，记录 30 日以内每天的结果类别计数、首字延迟摘要和可计算 TPS 的聚合值，并保存少量近期结果状态。旧 schema v1/v2/v3 会在读取时迁移。数据通过临时文件原子替换，并用目录锁协调并发写入；无法解析的数据会备份为 `data.json.corrupt-<时间戳>`，最多保留 5 个损坏备份。

`error.log`（最大约 1 MB）仅记录统计数据损坏恢复、存储初始化失败和统计写入失败等存储诊断，不是通用扩展运行时异常日志。统计文件不保存请求错误消息；诊断日志可能包含异常文本，使用或分享前请先检查并按需脱敏。

## 项目结构

```text
src/index.ts          扩展注册、命令和快捷键
src/collector.ts      provider/assistant 生命周期被动采集
src/metrics.ts        错误分类、统计汇总、指标格式化
src/digest.ts         有界分位数摘要、合并、序列化与恢复
src/identity.ts       模型身份及配置指纹
src/config.ts         全局数据路径
src/storage.ts        数据校验、迁移、锁、原子持久化与保留策略
src/model-picker.ts   带统计后缀的模型选择器
src/types.ts          数据与指标类型
test/                 Vitest 测试
```

Pi `0.84.2` 的公开扩展 API 不提供原生模型选择器行装饰扩展点或默认模型持久化方法，因此本扩展使用自定义选择器，选择后切换当前 session 模型。扩展也不使用私有 API 或主动测活请求。

## 开发与验证

```bash
npm install
npm run validate  # TypeScript、ESLint、Vitest 全量检查
npm test          # 仅运行测试
npm run lint      # 仅运行静态检查
```

Smoke check（只验证加载，不发送模型请求）：

```bash
pi --no-extensions -e ./src/index.ts --offline --list-models "cpa/gpt"
```

