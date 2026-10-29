# 开发实验与用户界面隔离

2026-10-26：固定三步骤报表、恢复与幂等性实验保留在开发测试链中。

- 账号初始化只创建 OwnDesk Assistant。
- 首页、设置、流程页和 Agent 列表接口排除 `fixture/durable-report`。
- 用户任务列表依据受理时固定的 `configSnapshot.runtime` 排除 fixture，过滤发生在分页前。已有记录及成果完整保留。
- 首页直接访问实验任务 URL 返回 404。开发脚本继续通过原任务 API 查看状态、事件和成果。
- 前端已移除实验说明、默认实验指令、运行实验按钮及费用页实验提示。

## 开发入口

`tests/fixtures/recovery-lab.ts` 的 `ensureRecoveryLab()` 显式准备固定实验 Agent。
`tests/web.ts`、`tests/runtime.ts`、`tests/telegram.ts` 在各自测试库配置就绪后按需调用。

- `npm run test:web`：拥有者认证、固定报表提交、恢复/事件与成果链。会创建固定实验任务。
- `npm run test:ui`：正常界面、实验入口隔离、Agent/任务列表、桌面及移动端布局。无需提交任务或请求模型。

## 本次实际验证

- TypeScript 和生产构建通过。
- 主库只读检查：保留 1 个开发实验 Agent；用户侧 1 个正式 Agent、5 个正式任务，列表无 fixture。
- 实际浏览器确认：首页选择器仅显示 OwnDesk Assistant；设置页无 Recovery Lab；新对话显示空白“交办任务”和“交给 Agent”。
- 仅重启网页服务；worker、历史任务、成果与费用记录保留。无新增任务、模型请求或桌面操作。
- 更新后的测试脚本已保存，本次未重跑历史恢复/报表任务。
