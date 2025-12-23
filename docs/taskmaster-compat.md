# Tachikoma ↔ Task Master `tasks.json` 兼容规格（调研 + 方案草案）

> 目标：让 Tachikoma 的任务规划/持久化内核 **1:1 支持** `eyaltoledano/claude-task-master` 的
> `tasks.json` 格式与语义：可直接读取外部
> `tasks.json`，执行未完成任务，回写状态，并可在中断后恢复继续。
>
> 本文所有结论均基于仓库真实实现：`third_party/claude-task-master/*` 与 Tachikoma 现有
> `packages/core/*`。

## 0. Tachikoma 侧新增约束（你已明确）

- **单一任务真相**：只保留 Task Master 的 `tasks.json` 作为任务的“描述 + 状态 + 依赖”来源。
- **`runtime.json` 脱敏**：允许存在 Tachikoma 的 `runtime.json`，但其中**不允许落盘任务描述文本**
  （例如 objective/description/details/testStrategy 等），只允许 id/状态/执行顺序/运行信息。
- **失败不回写**：Tachikoma `failure` 不写回 `tasks.json`（保持原 status，失败只记录在 Tachikoma
  session）。
- **允许执行期细分**：允许在执行期判断某个 task/subtask 过大并继续 expand（例如 `1.1` →
  `1.1.1`），但 **细分结果必须写回 `tasks.json`**（不在 `runtime.json` 落盘描述）。

## 1. Task Master 侧：`tasks.json` 的“真实文件约定”

### 1.1 默认路径约定

- 标准路径：`.taskmaster/tasks/tasks.json`
- 兼容旧路径：`tasks/tasks.json`

证据：`third_party/claude-task-master/packages/tm-core/src/common/constants/paths.ts`

### 1.2 允许的文件形态（必须同时兼容）

Task Master 同时存在两套读写实现：**CLI 的 tag-aware `readJSON/writeJSON`** 与 **tm-core 的
`FileStorage/FormatHandler`**。二者对“格式命名”不同，但都在生产环境出现，因此 Tachikoma 必须兼容并能 round-trip 不丢数据。

- **形态 A：Tag 容器（CLI 常态）**

```json
{
  "master": {
    "tasks": [
      /*...*/
    ],
    "metadata": {
      /*...*/
    }
  },
  "feature-x": {
    "tasks": [
      /*...*/
    ],
    "metadata": {
      /*...*/
    }
  }
}
```

CLI 的 `hasTaggedStructure(data)` 判定：任一顶层 key 的值为对象且含 `tasks: []` 即视为 tag 容器。

- **形态 B：Standard（tm-core 在只有 master tag 时的输出）**

```json
{
  "tasks": [
    /*...*/
  ],
  "metadata": {
    /*...*/
  }
}
```

tm-core 的 `FileStorage.saveTasks()` 在 `resolvedTag === 'master'`
且文件未呈现 tag 容器时，会写成这种顶层 `tasks/metadata` 结构；一旦写入非 master
tag，会把文件转换成形态 A。

- **形态 C：更老的 legacy（仅 tasks 数组，可能带/不带 metadata）**

```json
{
  "tasks": [
    /*...*/
  ]
}
```

CLI 的 `readJSON()` 会把“顶层 tasks 且非 tag 容器”的文件**迁移**成形态 A（写回文件），并补齐
`.taskmaster/state.json`/`.taskmaster/config.json` 等迁移所需文件。

## 2. Task Master 侧：Tag 解析与回写合并（关键：避免多 tag 数据丢失）

### 2.1 Tag 解析优先级

CLI 侧解析规则：

1. 显式传入 `tag`
2. `.taskmaster/state.json` 的 `currentTag`
3. `.taskmaster/config.json` 的 `global.defaultTag`
4. fallback：`master`

证据：`third_party/claude-task-master/scripts/modules/utils.js` 中的
`getCurrentTag()`/`resolveTag()`

### 2.2 `readJSON(tasks.json)` 的返回形态（兼容层）

当读到形态 A（tag 容器）时，`readJSON()` 不会直接返回整个容器，而是返回“**当前 tag 的
`{tasks, metadata}`**”，并额外带上：

- `tag`: resolvedTag
- `_rawTaggedData`: **整个 tag 容器的深拷贝快照**

这允许上层旧逻辑像在操作“单 tag 的 tasks.json”一样只改
`tasks`，同时在写回时还能把变更合并回原容器，避免覆盖其他 tag。

证据：`third_party/claude-task-master/scripts/modules/utils.js` 的 `readJSON()`

### 2.3 `writeJSON(tasks.json)` 的合并语义

当传入的数据包含 `_rawTaggedData` 且有 `projectRoot` 时：

- `writeJSON` 会把 `{tasks, metadata}` 合并回
  `_rawTaggedData[resolvedTag]`，并把其它 tag 原样保留，再整体落盘。
- 若出现“resolved data 丢失 `_rawTaggedData`”的 edge case（MCP 路径曾出现），`writeJSON`
  会**重读文件**获取全量容器，再仅替换目标 tag 的 `tasks`，避免覆盖其它 tag。

证据：`third_party/claude-task-master/scripts/modules/utils.js` 的 `writeJSON()`

## 2.4 `state.json` / `config.json` 对 Tachikoma 是否有用？

这两个文件在 Task Master 中主要是**为 tag 系统服务**，不是任务数据本体：

- `.taskmaster/state.json`：保存 `currentTag` / branchTagMapping /
  migrationNoticeShown（用于“当前 tag 选择”和 CLI 辅助行为）
- `.taskmaster/config.json`：保存 `global.defaultTag` 等配置（用于“默认 tag 选择”，以及 Task
  Master 自身的配置）

在 Tachikoma 里：

- **核心执行不需要它们**：只要能读到 `tasks.json`，就能执行与回写（status 回写回 `tasks.json`）。
- **可选的“tag 提示”用途**：当 `tasks.json` 是多 tag 容器时，我们需要决定运行哪个 tag。
  - 若你希望“只靠 `tasks.json` 一个文件”，那就**不依赖**这两个文件：默认 `master`
    或要求显式传入 tag。
  - 若你希望更贴近 Task Master
    CLI 的体验，可以把它们当作**可选读取**的提示（读得到就用 currentTag/defaultTag，读不到就回退 master），但 Tachikoma
    **不生成/不修改**它们。

## 3. Task Master 侧：IDs、子任务与依赖语义

### 3.1 IDs 的现实：同时出现 number 与 string（必须兼容）

- CLI `normalizeTaskIds()` 会把 **Task.id 与 Subtask.id 都归一为 number**（并处理 `subtask.id`
  的 dotted 字符串形式，取最后一段）。
- tm-core `FormatHandler.normalizeTasks()`/`FileStorage.normalizeTaskIds()` 则倾向于：
  - Task.id：string
  - Task.dependencies：string[]
  - Subtask.id：number
  - Subtask.parentId：string

结论：Tachikoma 兼容层应：

- **读取时**：允许 task/subtask
  id 既是 number 也可以是 string，并统一在内存中当作 string 比较（尤其用于依赖解析）。
- **写回时**：尽量保持原文件的 id 表示（减少无谓 diff），仅做最小字段更新（典型是 status/updatedAt/metadata 计数）。

### 3.2 子任务的“dotted id”语义

tm-core 的 `TaskService.getNextTask()` 与 `FileStorage.loadTask()` 都支持把 subtask 以 dotted
notation 表达为 `parentId.subId`：

- subtask 本体在 tasks.json 中通常存为：`{ id: 2, parentId: "1", ... }`
- 在“选择/查找/依赖”时，经常转换成：`"1.2"`

关键规则：subtask.dependencies 里如果不是 dotted（例如 `2`），会被补全为同父任务下的
`"parentId.2"`。

### 3.3 依赖满足（注意：代码中存在不一致）

tm-core `TaskService.getNextTask()` 构造 `completedIds` 时，仅把 `status === 'done'`
的 task/subtask 视为“已完成”，并以此判断依赖是否满足。

但 tm-core 的常量 `TERMINAL_COMPLETE_STATUSES` 又把 `cancelled` 与（workflow 语境下的）`completed`
也视为“终态完成”。

这意味着：**TaskService 的 next-task 选择逻辑** 与
**常量定义**存在不一致，兼容实现需要显式选择“跟随哪一套”。

## 4. Task Master 侧：状态回写（FileStorage 的真实行为）

tm-core `FileStorage.updateTaskStatus(taskId, newStatus)`：

- `taskId` 包含 `.` 时按 subtask 更新，否则按 task 更新。
- 更新 subtask 后，会根据 subtasks 状态**自动调整 parent task 状态**：
  - all done-like（`done` 或 `completed`）→ parent `done`
  - any `in-progress` 或 any done-like → parent `in-progress`
  - all `pending` → parent `pending`

注意：这里对 `cancelled` 的处理与 `TaskEntity.canComplete()` 也存在口径差异（`TaskEntity`
允许 subtasks `done|cancelled` 才能 complete），因此 Tachikoma 侧需要决定“对齐哪一个行为”。

## 5. Tachikoma 侧：现状与可复用能力（用于映射设计）

- 会话计划：`packages/core/src/orchestrator/session/session-file-manager.ts`
  - `runtime.json` 持久化 `PlannerOutput`
  - 支持
    `appendRefinedSubtasks()`：细分后替换执行计划，并把下游对父 id 的依赖改为依赖“最后一个细分子任务”
- Orchestrator：
  - 保存 `runtime.json`：`saveRuntimeToSession()`
  - 进度落盘在 `progress.json`（completed/failed/running 的 subtask ids）
  - 自动细分 subtask id：`baseId.index`（天然兼容 dotted id）
  - roles 归一化：会生成稳定 `role:<id>` capability，并把角色约束注入 subtask.constraints

## 6. 方案草案（待确认后编码）

### 6.1 新增 Task Master 兼容层（核心模块）

在 `packages/core/src/taskmaster-compat/` 新增：

- `TasksJsonIO`：读取/写回 `tasks.json`
  - 支持形态 A/B/C
  - 支持 tag 选择（默认读取 `.taskmaster/state.json`，否则 `master`）
  - 写回时保留原始容器（类似 CLI `_rawTaggedData` 合并策略）
- `TasksJsonPlanner`：把 `tasks.json` 转换成 Tachikoma `PlannerOutput`
  - 可执行单元建议：优先执行 subtask（dotted id），无 subtasks 的 task 作为单独 subtask 执行
  - executionPlan：基于 dependencies 做拓扑排序；并行分组可后续增强
- `StatusMapper`：Task Master status ↔ Tachikoma status 映射（见 6.2）
- `StatusWriter`：在 Orchestrator 事件点（assigned/complete/failed）回写 `tasks.json`
  的 task/subtask.status

#### 6.1.1 兼容层与 Orchestrator 的集成点（建议）

Tachikoma 当前规划入口在 `Orchestrator`：**默认以 `tasks.json` 作为唯一计划源（SoT）**。统筹者会：

- 通过 `workDir` 定位项目根
- `TasksJsonIO.read()` 读入 tasks.json（含 tag 解析）
- `TasksJsonPlanner.buildPlannerOutput()` 生成 `PlannerOutput`（subtasks + executionPlan）
- 当 tasks.json 为空时，调用 LLM
  Planner 生成初始 tasks 并写回 tasks.json（仍保持 tasks.json 为唯一真相）

与此同时，执行阶段中 Orchestrator 会发出 `subtask:*`
事件（assigned/complete/failed/retrying 等）。建议在这些事件点调用 `StatusWriter` 进行 `tasks.json`
的最小回写（只改 status/updatedAt/必要 metadata 计数）。

> 注意：在你新增的“runtime.json 脱敏”约束下，已将 `SessionFileManager.writeRuntime/readRuntime`
> 作为唯一入口；`runtime.json` 只落盘 subtaskId/状态/执行顺序/角色映射等运行字段， **不落盘**
> objective/constraints 等任务描述文本（任务描述只存在于 tasks.json）。

#### 6.1.2 字段映射（Task Master → Tachikoma SubTask）

当把 Task Master 的 task/subtask 映射为 Tachikoma 的 `SubTask` 时，建议：

- `SubTask.id`
  - Task：`String(task.id)`
  - Subtask：`"${String(parent.id)}.${String(subtask.id)}"`（dotted）
- `SubTask.parentId`：建议统一填“本次执行的根 taskId”（例如
  `taskmaster:${tag}`），避免引用不存在的父节点
- `SubTask.objective`：`"${title}: ${description}"`（尽量短）
- `SubTask.constraints`：承载 `details/testStrategy/parent 信息` 等长文本，避免把 objective 拉长
- `SubTask.dependencies`：
  - Task：来自 `task.dependencies`
  - Subtask：`subtask.dependencies` 补全 dotted（同父任务下的数字依赖 →
    `${parentId}.${n}`），并叠加父任务的 `task.dependencies`（确保跨 task 依赖约束对子任务生效）

#### 6.1.3 `runtime.json`（脱敏引用格式）

你已明确：`runtime.json` **不能**包含任务描述文本，因此 `runtime.json` 仅保存“引用 + 调度 + 角色”：

- `tasksJson.path/tag`：指向唯一真相 `tasks.json`
- `executionPlan`：仅包含要执行的 id 顺序（不含 objective/constraints）
- `roles`/`roleAssignments`：用于 Worker 路由（按 id 引用，不污染 `tasks.json`）
- `originalStatuses`：用于 failure keep-status（失败后回滚到执行前 status）

实现上仅保留
`TaskMasterRuntimeFile`（`packages/core/src/orchestrator/session/types.ts`）：session 内固定写
`runtime.json`（脱敏引用格式）。**不再支持**包含 `plannerOutput` 的 runtime 格式。

> ✅ 已确认：session 内文件名固定为 `runtime.json`，不做任何旧文件名兼容读取/迁移。

### 6.2 状态映射（建议默认）

| Task Master                         | Tachikoma SubTaskStatus     | 说明                                                     |
| ----------------------------------- | --------------------------- | -------------------------------------------------------- |
| `pending`                           | `pending`                   | 未开始                                                   |
| `in-progress`                       | `running`                   | 执行中                                                   |
| `done`                              | `success`                   | 成功完成                                                 |
| `cancelled`                         | `cancelled`                 | 取消                                                     |
| `blocked/deferred/review/completed` | `pending`（并在约束里标注） | Tachikoma 无对应枚举，默认视为不可执行或待处理（可配置） |

失败写回（Tachikoma `failure`）在 Task Master 中没有直接 status，对齐策略二选一：

- A：写回 `blocked`，并把失败原因追加到 `details`（不新增字段）
- B：保持原 status（常见是 `in-progress`），失败仅记录在 Tachikoma
  session（更“纯”，但外部仅靠 tasks.json 难以判断失败）

### 6.3 roles/capabilities 不污染 `tasks.json`

默认不写入 `tasks.json`。roles/roleAssignments 由 Orchestrator 通过 **LLM 统筹推理**生成，并写入
`tachikoma.taskmeta.json`（按 tag 隔离），用于稳定的 Worker 路由与能力过滤。

#### 6.3.1 `tachikoma.taskmeta.json`（建议 schema）

> 仅存 Tachikoma 专属信息（roles/capabilities、执行偏好），**不写入** Task Master 的 `tasks.json`。

建议放在项目根目录（与 `tasks.json` 同级），文件名固定：`tachikoma.taskmeta.json`。

```json
{
  "version": 1,
  "tasksJson": {
    "path": ".taskmaster/tasks/tasks.json",
    "tag": "master"
  },
  "roles": {
    "byId": {
      "generalist": {
        "name": "通用执行者",
        "capabilities": ["role:generalist"]
      }
    },
    "assignments": {
      "master": {
        "1": { "roleId": "generalist" },
        "1.2": { "roleId": "generalist" }
      }
    }
  },
  "execution": {
    "failureWriteback": "keep-status",
    "allowRefinement": true
  }
}
```

说明：

- `roles.byId`：定义 role（供 Tachikoma WorkerPool 使用）
- `roles.assignments[tag][taskOrSubId]`：对单个 task/subtask 指定 roleId/capabilities（不写入 tasks.json）
- `execution.*`：与 “tasks.json 作为唯一任务真相” 相关的执行行为开关（例如失败写回策略、是否允许运行时细分）

### 6.4 外部投喂与恢复

- 启动：自动探测 `tasks.json` 路径（优先 `.taskmaster/tasks/tasks.json`，其次
  `tasks/tasks.json`，最后允许显式指定）
- 恢复：
  - 有 Tachikoma checkpoint：按 checkpoint 恢复，并以 tasks.json 作为状态对账来源（best-effort）
  - 无 checkpoint：直接从 tasks.json 重建 PlannerOutput（根据 status/依赖过滤已完成项），继续执行

### 6.5 需要改造的 Tachikoma 文件（MVP 切面）

- 新增模块：`packages/core/src/taskmaster-compat/*`
  - `tasks-json-io.ts`（读写 + tag/格式兼容 + round-trip）
  - `tasks-json-planner.ts`（拓扑排序生成 executionPlan）
  - `status-mapper.ts` / `status-writer.ts`
- 修改 Orchestrator：`packages/core/src/orchestrator/orchestrator.ts`
  - `executePlanPhase()`：支持 `planSource: 'taskmaster'` 分支
  - 在 subtask 状态变化点调用 `StatusWriter`（或订阅 `subtask:*` 事件集中回写）
- 可选：新增配置/元数据约定（避免破坏现有调用）

### 6.6 待你确认的 3 个“会影响实现细节”的问题

1. ✅ 已确认：外部投喂 `tasks.json` 的默认路径优先级按 6.4（`.taskmaster` 优先）。
2. ✅ 已确认：Tachikoma `failure` **不写回** Task Master（保持原 status，失败只记录在 Tachikoma
   session）。
3. ✅ 已确认：允许运行时细分，但**细分结果必须写回** `tasks.json`（允许对既有 subtask 继续细分，如
   `1.1` → `1.1.1`）。

---

> 下一步：把本草案拆成 `tm-compat-2/3` 的可执行改造点清单，并等你确认“外部投喂路径优先级 /
> failure 写回策略 / 是否允许运行时细分 subtask（不写回 tasks.json）”后三方一起落代码。
