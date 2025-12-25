# Task 18 实现方案：Agent Identity Persistence（对齐 Letta，避免与现有体系冲突）

## 0. 目标与成功标准

### 0.1 目标

在不破坏 Tachikoma 现有：

- `packages/core/src/memory/*`（向量/语义检索记忆）
- `packages/core/src/skills/*`（技能发现、学习、blocks、/skill）
- `packages/core/src/conversation/conversational-runner.ts`（当前 slash commands 实现）

的前提下，实现 Letta-Code 风格的：

- Agent Identity（跨会话“同一个人”）
- 分层 Memory Blocks（全局/项目，含只读 blocks）
- `/remember`（用户显式授权写入）
- Letta 语义 `/clear`（清空会话消息但保留持久记忆）

### 0.2 成功标准（闭环）

- **Blocks 落盘**：存在并维护
  - `~/.tachikoma/memory/persona.md`
  - `~/.tachikoma/memory/preferences.md`
  - `${project}/.tachikoma/memory/project.md`
  - `${project}/.tachikoma/memory/skills.md`
  - `${project}/.tachikoma/memory/loaded_skills.md`
- **只读约束**：`skills/loaded_skills` 不允许任意写，只能由 skill 工具或 /skill 命令更新。
- **注入闭环**：Worker system prompt 中必须稳定注入（按顺序约束，见 §5）：
  - Identity Core Memory（弱约束偏好/原则）
  - project blocks
  - loaded_skills（用户/agent 手动加载的技能正文）
- **/remember 生效**：写入 preferences 或 project 后，后续任务行为可观察变化（通过集成测试验证）。
- **/clear 语义一致**：清空会话消息后，blocks 与 identity 仍存在；下次任务仍受其影响。
- **不与 MemoryService 打架**：blocks 与语义检索的职责清晰、无重复注入风暴。

---

## 1. 顶层边界：两套“记忆”必须分工协作

### 1.1 Memory Blocks（deterministic prompt memory）

- **形态**：label → markdown/text 文件
- **用途**：确定性注入到 prompt（可审计、可版本化）
- **典型内容**：persona、preferences、project rules、skills 列表、loaded_skills

### 1.2 MemoryService（semantic retrieval memory）

见 `packages/core/src/memory/*`，它是 embedding + provider 的检索系统：

- **用途**：按 query/上下文检索相关记忆（非确定性）
- **scope**：session/user/declarative/procedural/collective

### 1.3 强约束（避免冲突）

- blocks 是“提示词资产”，MemoryService 是“检索系统”，两者**不能互相替代**。
- `/remember` 默认写入 blocks；只有在明确需要时才把“长细节”写入 MemoryService（metadata 标明
  `source:user-command`）。
- 不允许自动把检索结果长期写回 blocks（除非用户确认）。

---

## 2. 数据落盘与隔离模型（对齐 Letta）

### 2.1 全局 blocks（跨项目共享）

目录：`~/.tachikoma/memory/`

- `persona.md`
- `preferences.md`

### 2.2 项目 blocks（按 workDir 隔离）

目录：`${project}/.tachikoma/memory/`

- `project.md`
- `skills.md`（可用技能列表的“快照视图”，只读，由工具刷新）
- `loaded_skills.md`（已加载技能正文聚合，只读，由工具管理）

### 2.3 Agent Identity（跨会话状态 + Core Memory）

目录：`~/.tachikoma/agents/`

- `{agentId}.json`

> 关键决策：agentId 的来源（环境变量/默认值/多身份）。建议 Phase A 先支持
> `default`，并允许 env 覆盖。

---

## 3. Block 系统实现（BlockLoader/Writer）

### 3.1 新增模块建议

新增目录：`packages/core/src/agent-identity/`

- `blocks.ts`：labels、BlockLoader、BlockWriter、readOnly 校验
- `identity.ts`：AgentIdentity load/save
- `evolution.ts`：CoreMemoryEvolver（带长度上限与去敏）

### 3.2 BlockWriter 原子写与防御

- 原子写：写临时文件 → rename
- 最大文件大小限制（防止 prompt 爆炸）
- 文本规范化（统一换行/去除非法字符）
- READ_ONLY blocks：默认拒绝写入；仅允许来自 `skillTool` 或受信 caller 的写入

---

## 4. 与 Task 17 的 SkillBlockManager 整合（避免“双真相”）

### 4.1 现状

Task 17 已有 `SkillBlockManager`（进程内 blocks）与 `skillTool`/`/skill` 更新 blocks。

### 4.2 目标

让 `skills/loaded_skills` 从“进程内状态”升级为“项目级持久化 blocks”，确保：

- 进程重启后 loaded_skills 仍存在
- /skill load/unload 更新落盘

### 4.3 最小冲突实现策略

- BlockLoader/Writer 是底层真相
- `SkillBlockManager` 继续负责：
  - `SKILL_CONTENT_SEPARATOR` 管理
  - `renderLoadedSkillsForPrompt()` 格式化
- 在 skill 更新路径上（`skillTool` & `/skill load/unload/refresh`）落盘写
  `${project}/.tachikoma/memory/{skills,loaded_skills}.md`
- 在 Runner/Worker 启动时，从 `${project}/.tachikoma/memory/loaded_skills.md` 初始化 block manager

---

## 5. Prompt 注入顺序（必须写死，防冲突）

Worker system prompt 推荐拼接顺序：

1. Base system prompt（各 backend 现有 DEFAULT）
2. **Identity coreMemory.systemPrompt**（弱约束：偏好/原则）
3. Role prompt（强约束：职责）
4. Task constraints
5. project.md（项目规则/上下文）
6. skills discovery section（自动推荐/激活的列表与正文）
7. **loaded_skills**（用户/agent 手动 load 的技能正文）

约束：

- 手动 loaded_skills 必须最后注入或至少在“可能裁剪/重写的段落”之后注入。

---

## 6. `/remember` 设计（用户显式授权写入）

### 6.1 命令语义

- `/remember <content>`：直接写入（优先 blocks）
- `/remember`（无 content）：从最近对话提炼候选，并要求用户确认后再写入（避免误记）

### 6.2 写入路由（建议规则）

- `preferences.md`：输出风格/语言/工作方式/约束偏好
- `project.md`：项目约束（目录结构、测试要求、提交规范）
- `persona.md`：尽量少写（避免 prompt 漂移）

可选：把“长细节/原始对话”写入 MemoryService 的 `user` scope，blocks 只存摘要规则。

---

## 7. `/clear` 语义（对齐 Letta，避免重复实现）

### 7.1 现状

`ConversationalRunner` 已有 `executeClear()`（清空 messages/history/checkpoints 可选）。

### 7.2 Task18 的建议调整

- **不新增** `conversation/commands/clear.ts` 另起炉灶。
- 在现有 `executeClear()` 基础上确保：
  - 清空会话消息/上下文缓存
  - **不清空** blocks 与 identity
  - 如需“清空持久记忆”，另提供 `/forget`（不属于 Task18 MVP）

---

## 8. 测试与验收（必须能跑的最小闭环）

### 8.1 单元测试

- BlockLoader/Writer：全局/项目隔离、原子写、只读拒绝
- Identity：load/save、长度控制、去敏规则

### 8.2 集成测试（最关键）

- `/remember`：写入 preferences → 下一次 prompt 构造中出现该偏好
- `loaded_skills`：load → 写入 `.tachikoma/memory/loaded_skills.md` → 进程重启后仍注入 prompt
- `/clear`：清空会话后 blocks/identity 仍保留并生效

---

## 9. 分阶段落地（避免一次性大爆炸）

### Phase A（最小闭环）

blocks 落盘 + 加载 + prompt 注入（先不做自动进化）

### Phase B

/remember 写入 blocks（可选：写入 MemoryService(user) 的长细节）

### Phase C

identity 统计 + coreMemory 进化（必须带长度上限/去敏）
