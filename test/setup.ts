// src/config.ts 在模块求值时读取 PI_MODEL_STATS_DIR，且其优先级高于 getAgentDir()。
// 本仓库的 .pi/extensions/model-stats/index.ts 会在 Pi 会话中把该变量指向项目内的
// .pi/agent/model-stats；于是在 Pi 内部执行测试时，各测试文件的 getAgentDir mock 会被架空，
// StatsStore 把测试夹具（含故意损坏的数据）直接写进真实统计目录。
// 统一在此清除，让落盘位置只由各测试文件自己的 mock 决定。
delete process.env.PI_MODEL_STATS_DIR;

export {};
