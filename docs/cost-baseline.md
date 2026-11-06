# BYOK 成本基线（C0）

不编造单价。实际花费以你的密钥账单和本机 `companion_usage.cost_micros` 为准。

```sh
DATABASE_URL=... node scripts/cost-sample.mjs 3
```

会按天、按模型汇总最近 N 天已记账的调用。没有标价的模型可能 `cost_micros` 为空，脚本会在结尾说明。

建议：主模型 + `OWNDESK_FALLBACK_MODEL` 备用（跨提供商亦可）。主模型超时 / 5xx / 网络错误时，聊天与记忆整理会试备用一次；配置错误（缺 key、404）不会盲切。

中转站真实价格未接入目录前，勿把「每天约 $0.05」写进对外材料。
