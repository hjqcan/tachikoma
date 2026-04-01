Goal (incl. success criteria):
- 完成 `/Users/hjqcan/Documents/tachikoma/docs/Tachikoma 提示词系统 + 工具层升级计划.md` 的提示词系统与工具层收尾。
- 成功标准：提示词系统接通新 builder；工具层尽量贴近 `/Users/hjqcan/Documents/tachikoma/third-party/claude-code-main` 的核心模式；默认工具面收缩到最小 Claude Code 风格子集；死工具文件与无效导出被物理删除；verification/build/dev-server/package-install/expand-commit 线不再通过工具层兜一圈；相关测试通过。

Constraints/Assumptions:
- 中文沟通。
- 用户明确要求：工具层不要继续手写发明，尽量直接参考 `third-party/claude-code-main`；不需要这么多工具，没用的从默认/公共暴露面移除，并继续做物理删除，不留技术债务。
- 不回滚/覆盖无关改动；保留已有 fusion 相关改造和用户工作区改动。

Key decisions:
- 连续性账本以 `/Users/hjqcan/Documents/tachikoma/http:/CONTINUITY.md` 为准；根目录 `CONTINUITY.md` 保持镜像。
- 默认 worker 工具面固定为最小子集：`file_read`、`file_write`、`file_list`、`shell_run`、`code_search`、`apply_patch`、`spawn_subagent`、`todowrite`、`todoread`。
- verification/build/dev-server/package-install/expand-commit 线优先做“service 直调 / internal capability”或直接删除工具包装。
- 当前正在回答“升级计划是否已完成”的状态确认问题。

State:
- Done: 原计划中的提示词系统改造、核心工具层改造、工具面收缩、以及后续用户要求的内部工具协议剥离已完成。
- Now: 向用户汇总“是否完成”的结论与边界。
- Next: 若用户要求，把文档/task 清单也同步改成已完成状态，或继续清理网络能力 `web_search` / `deep_research`。

Done:
- 已完成提示词系统改造：
  - `packages/core/src/prompt/system-prompt/*`
  - `packages/core/src/worker/prompts/system-prompt.ts`
  - 删除 `packages/core/src/worker/prompts/behavior-guidelines.ts`
- 已完成工具层基础设施：
  - `packages/core/src/tools/build-tool.ts`
  - `packages/core/src/tools/read-file-state.ts`
  - `packages/core/src/types.ts` 增加工具安全元数据与 `ExecutionContext.readFileState`
  - `packages/core/src/tools/registry.ts` 增加 alias 查找与 prompt 描述选择
  - `packages/core/src/worker/engines/tool-schema.ts` 使用 `prompt()`/description 真源
  - `packages/core/src/sandbox/tool-executor.ts` 透传真实 `ExecutionContext`
- 已完成核心工具迁移：
  - `packages/core/src/tools/core/{shell-run,file-read,file-patch,file-write,code-search,file-list,todo,spawn-subagent}.ts`
- 已完成默认/公共工具面收缩与多轮物理删除。
- 已完成 verification/build/dev-server/package-install/expand-commit 线工具协议剥离。
- 回归测试通过；`tsc` 仅剩既有错误（eval/observability 老问题）。

Open questions (UNCONFIRMED if needed):
- 是否要继续清掉网络能力 `web_search` / `deep_research`。
- 是否要把 `docs/Tachikoma 提示词系统 + 工具层升级计划.task.md` 勾成完成。

Working set (files/ids/commands):
- `/Users/hjqcan/Documents/tachikoma/http:/CONTINUITY.md`
- `/Users/hjqcan/Documents/tachikoma/CONTINUITY.md`
- `/Users/hjqcan/Documents/tachikoma/docs/Tachikoma 提示词系统 + 工具层升级计划.md`
- `/Users/hjqcan/Documents/tachikoma/docs/Tachikoma 提示词系统 + 工具层升级计划.task.md`
