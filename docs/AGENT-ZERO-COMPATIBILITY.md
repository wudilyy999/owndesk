# Agent Zero 插件兼容

日期：2026-10-26。实现接入现有单 Agent 的任务、配置快照、模型工具、Shell 动作回执、取消/接管、未知效果复核和上下文压缩链。

## 使用

1. 打开设置页的「Agent Zero 社区插件」。点击「浏览官方索引」，按名称/用途搜索；也可输入公开 GitHub 插件仓库及分支、标签或提交。
2. 安装会解析根目录 `plugin.yaml`、保存固定提交的源码、读取 `default_config.yaml` 与工具提示词。安装不会执行插件、`hooks.py`、`execute.py` 或安装依赖。
3. 检查插件卡片的 Python 工具和未接入部分，再点击「启用工具」。配置编辑器接收普通 JSON 参数。插件密钥自动释放尚未接入，不能在配置中存放秘密。
4. 新建任务。例如启用 `todo_list` 后，让助手「用 Todo List 插件创建一个名为周报的待办，再列出待办」。工具通过 `agent_zero_call` 调用；无需修改原插件 Python 源码。
5. 对 `rg` 等依赖程序的插件，先在该 Agent 的容器中安装相应依赖。例如明确要求助手通过 Shell 安装 `ripgrep` 和 `tree`。容器系统层的软件在冷重建后需要重新准备；源码、home 内的数据与回执保留。

插件启停和配置影响后续任务。已受理任务保留原插件提交、工具列表、提示词和配置；停用不取消已有任务。需要停止在途执行时使用原任务取消按钮。

## 已对接的合同

| 原生态入口                          | 本工程行为                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| 官方 `a0-plugins` 生成索引          | 读取官方 release 的 `index.json`，搜索元数据并使用索引提交安装；无提交的条目显示原因并禁用索引安装  |
| `plugin.yaml`                       | 读取 name/title/description/version，区分社区插件名及保留名                                         |
| `tools/<name>.py`                   | 以模块名发现工具；调用时加载唯一的本模块 `Tool` 子类                                                |
| `helpers.tool.Tool/Response`        | 支持原构造参数、before/execute/after、日志和进度、Response.message/additional/break_loop            |
| `usr.plugins.<name>...`             | 在容器中提供原插件的模块命名空间，保留插件内部 helpers 导入                                         |
| `helpers.plugins.get_plugin_config` | 返回本任务冻结的该插件配置，拒绝跨插件取配置                                                        |
| `helpers.strings.sanitize_string`   | 文本接口兼容；实际展示由本工程现有工具消息处理                                                      |
| Agent 基本状态                      | 支持 agent_name、context.id、context.log、get_data/set_data、工具结果记录；状态按任务保存在 home 中 |
| `prompts/agent.system.tool.*.md`    | 作为第三方工具参考加入本任务系统上下文，说明原调用格式到 wrapper 的映射                             |

`break_loop` 返回为 `breakLoopRequested`，不会绕过本工程的 `complete_task` 和成果检查。插件异常退出后按原动作链进入效果复核，不自动重复执行。

## 本轮范围

- 原生 Python **工具合同的子集兼容**。依赖 Agent Zero 其他 helpers、完整 Agent 对象、模型/记忆/项目管理 API 的工具需要进一步适配。
- Agent Zero 的前端、Alpine store、API handler、Python 生命周期钩子、隐式函数 hooks、子 Agent 配置和 Skill 自动发现未接入。卡片逐项标注，不自动加载。
- `hooks.py` 和 `execute.py` 不自动执行。安装包要求公开 GitHub 仓库根目录有 `plugin.yaml`，最多 200 个普通文件、约 1 MiB；不接受符号链接或子模块。大插件、ZIP、本地目录、私有仓库与自动依赖管理暂未支持。
- 插件仍具有该桌面容器内普通 Agent 的代码执行能力。本轮不提供额外的逐插件权限沙盒，不把插件目录隔离当作系统权限边界。
- 启用上限 12 个；工具说明合计超过 48,000 字符时明确拒绝新任务，避免静默丢失文档。最终仍走原上下文预算。

## 数据和恢复

复用 PostgreSQL `settings`：`plugins.agentZero.registry` 保存当前安装及启用配置；`plugins.agentZero.package.<name>.<commit>` 保存不可覆盖的源码包。旧版本保留供已受理任务恢复。未新增 SQL 迁移或 guest 协议。

任务/执行段 `configSnapshot.agentZeroPlugins` 固定元数据和普通配置。实际调用前通过受信任的 Docker stdio bootstrap 将该包及本工程桥脚本复制到容器 home；复制阶段不导入第三方代码。随后仍使用 `executeAction(..., "shell", ...)` 的原派发 ID 执行 Python 工具。源码准备只发生在原 authorizer 派发边界；已有成功动作复用回执。

容器路径：`/home/agent/.local/share/personal-agent/agent-zero/<name>/<commit>`。插件自己的数据保存在这个版本目录；更新到新提交不会自动迁移旧数据。桥的结果文件使用原 `PA_ACTION_ID`，在 Shell 日志裁剪之外保留完整 JSON；读取后继续原工具结果裁剪/上下文策略。

数据库备份包含安装注册表和所有固定源码包；home 快照包含插件数据和执行回执，复用现有一致备份流程。跨版本自动数据迁移、插件卸载与旧包清理尚未提供。

## 定向验证

`npx tsx --test tests/agent-zero.test.ts` 覆盖索引的缺版本/null 标签、源码检查不执行代码、外部路径/仓库/YAML、冻结工具名单、桌面专用通道、提示词、原始 Tool/Response/模块导入、跨进程状态和长返回。

`npx tsx tests/agent-zero-plugins.ts` 创建隔离数据库、新拥有者和独立桌面，使用生产 Web/worker 与本地固定模型响应。通过拥有者 API 安装两个原社区插件、测试索引与同源边界，在原任务链执行搜索和待办创建/读取，再检查同逻辑动作回放和停用后的旧任务配置冻结。真实云模型调用数为零。结果与失败保留在 `docs/evidence/agent-zero-plugins.json` 和其引用的隔离实验目录。

这项验证不代表整个官方插件目录均可运行，也不评价真实模型选择插件的准确率。

## 参考源与许可

- Agent Zero 框架参考提交：`ff2a5b9c9c4e490ba38dd7c313e779510bb2071a`；合同来自 `plugins/AGENTS.md`、`helpers/tool.py`、插件安装器的官方索引地址。MIT；版权归 Agent Zero, s.r.o。
- Ripgrep Search 原仓库：`linkliti/a0-plugin-rg`，验证提交 `66e6d6ddf6ef115985ac60a2c1f79bb56c36b010`。
- Todo List 原仓库：`Reaperrhs/agent-zero-todo-list`，验证提交 `888b8c36327972c41a86e9a68a685f6f7c525ded`。
- 第三方包保留各自仓库的 LICENSE 和源码；本工程没有将参考 checkout 的代码全量迁入交付仓库。Python 桥为本工程的合同适配实现。
