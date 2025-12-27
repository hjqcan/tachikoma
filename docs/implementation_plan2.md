# Verification System - Gap Analysis & Implementation Plan

## 用户计划 vs 已完成工作

### 对比表

| Phase | 用户计划 | 已完成 | 状态 |
|-------|---------|--------|------|
| **Phase 0** | Metrics, SLA, Dashboard | ❌ | 🔴 **需要新增** |
| **Phase 1** | ProjectDetector | ✅ [project-detector.ts](file:///Users/hjqcan/Documents/tachikoma/packages/core/src/orchestrator/services/project-detector.ts) | 🟢 **完全重叠** |
| **Phase 2** | Build/Test/Smoke Gate | ✅ BuildGate 在 VerificationGate 中 | 🟡 **部分重叠** |
| **Phase 3** | Replan/Repair Loop | ✅ Fix loop (不含 replan) | 🟡 **部分重叠** |
| **Phase 4** | UI Smoke + Browser | ✅ E2E layer 骨架 (只有 HTTP) | 🟡 **需要完善** |
| **Phase 5** | Diff-Aware Diagnostics | ❌ | 🔴 **需要新增** |
| **Phase 6** | Tests & CI | ❌ | 🔴 **需要新增** |

---

## 详细分析

### 🟢 Phase 1: ProjectDetector - **完全重叠**

**已实现:**
```typescript
// services/project-detector.ts
class ProjectDetector {
  async detect(workDir: string): Promise<ProjectConfig> {
    return {
      projectType,      // typescript | javascript | python
      typeCheckCommand, // npx tsc --noEmit
      buildCommand,     // npm run build
      testCommand,      // npx vitest run
      devCommand,       // npm run dev
      lintCommand,      // npx eslint .
      testFramework,    // vitest | jest | bun | pytest
      packageManager,   // npm | yarn | pnpm | bun
    };
  }
}
```

**用户计划要求 vs 实现:**
| 要求 | 状态 |
|------|------|
| Infer from package.json | ✅ 已实现 |
| Infer from pyproject.toml | ⚠️ 检测存在，未解析 commands |
| Infer from requirements.txt | ⚠️ 检测存在，未解析 commands |
| Infer from vite.config | ❌ 未实现 |
| buildCommand | ✅ |
| testCommand | ✅ |
| smokeCommand | ❌ 未实现 |
| devCommand | ✅ |

**差距:** 需要添加 `smokeCommand` 和更好的 Python/vite 支持

---

### 🟡 Phase 2: Hard Gating - **部分重叠**

**已实现:**
- ✅ BuildGate via `VerificationGateService.verify({ layers: ['type'] })`
- ✅ TestGate 骨架: `layers: ['test']` 可用
- ❌ SmokeGate: 未独立实现
- ✅ Hard fail at end of plan
- ✅ Update status on failure

**用户计划 vs 实现:**
| Gate | 状态 | 备注 |
|------|------|------|
| BuildGate (type check) | ✅ | 通过 VerificationGate type layer |
| BuildGate (npm run build) | ✅ | 通过 VerificationGate build layer |
| TestGate | ⚠️ | test layer 存在但未默认启用 |
| SmokeGate | ❌ | 需要新增: 启动 server + HTTP + browser |
| Parallel fail → repair | ✅ | 已抛出错误，但无 repair agent |

**差距:**
1. 需要 `SmokeGateService` 独立服务
2. 需要在 parallel step 失败时触发 repair/replan (当前只 throw)

---

### 🟡 Phase 3: Replan/Repair Loop - **部分重叠**

**已实现:**
```typescript
// Inner fix-verify loop in executeSubtask
while (buildGateFixAttempts <= MAX) {
  const verifyResult = await verificationGateService.verify(workDir);
  if (verifyResult.passed) break;
  
  if (buildGateFixAttempts >= MAX) {
    throw new Error(...); // FAIL, no replan
  }
  
  // Create fix task
  const fixTask = this.createBuildFixTask(...);
  await agent.run(fixTask);
  
  buildGateFixAttempts++;
}
```

**用户计划 vs 实现:**
| 功能 | 状态 |
|------|------|
| Automatic Repair (fix task) | ✅ |
| Replan after N failures | ❌ 当前只 throw |
| Replan for parallel conflicts | ❌ |
| Error normalization | ✅ VerificationError 格式化 |
| Repair context in prompts | ⚠️ 基础实现 |

**差距:**
1. 需要 replan 逻辑：失败 N 次后调用 Planner 重新规划
2. 需要并行冲突时串行化策略

---

### 🟡 Phase 4: UI Smoke - **需要完善**

**已实现:**
```typescript
// VerificationGateService.runE2E() - 只有 HTTP check
try {
  const response = await fetch(options.devServerUrl);
  // ... 
} catch (error) {
  // ...
}
```

**用户计划 vs 实现:**
| 功能 | 状态 |
|------|------|
| Start FE+BE in background | ❌ |
| Wait for port | ❌ |
| HTTP check | ✅ |
| Browser: open UI | ❌ |
| Browser: verify selectors | ❌ |
| Browser: screenshot | ❌ |
| Browser: console errors | ❌ |
| MCP Chrome Dev | ❌ |

**差距:**
1. 需要集成 `browser_verify` tool
2. 需要 dev server 管理 (start/stop/wait)
3. 需要 console error capture

---

### 🔴 Phase 5: Diff-Aware Diagnostics - **需要新增**

**已实现:** ❌ 无

**用户计划:**
- Baseline errors recording
- Only fail on new errors
- Pass changed files to LSP

**差距:** 完全需要新增

---

### 🔴 Phase 6: Tests & CI - **需要新增**

**已实现:** ❌ 无

---

## 实施优先级

基于用户建议的顺序和差距分析：

### 优先级 1: Hard Gates + Status (已大部分完成)
- [x] Hard fail at end of plan
- [x] Status propagation
- [ ] **新增:** Metrics counters

### 优先级 2: SmokeGateService (新增)
- [ ] 创建 `smoke-gate.ts`
- [ ] 启动 dev server (使用 [dev-server.ts](file:///Users/hjqcan/Documents/tachikoma/packages/core/src/tools/core/dev-server.ts) 工具)
- [ ] 等待端口可用
- [ ] HTTP health check
- [ ] 集成 `browser_verify` tool

### 优先级 3: Replan/Repair (扩展)
- [ ] 失败 N 次后调用 Planner.replan()
- [ ] 并行冲突时的串行化策略

### 优先级 4: Diff-Aware (新增)
- [ ] BaselineManager service
- [ ] 记录 pre-existing errors
- [ ] 只 fail on new errors

### 优先级 5: Tests
- [ ] Unit tests for gates
- [ ] Integration tests

---

## 冲突与决策

### 决策 1: Gate 架构

**用户计划:** 独立的 BuildGate, TestGate, SmokeGate 服务
**我的实现:** 统一的 VerificationGateService with layers

**建议:** 保持 VerificationGateService 架构，添加 SmokeGate 作为额外 layer
```typescript
layers: ['type', 'build', 'test', 'smoke']
```

### 决策 2: Replan 触发

**用户计划:** N 次失败后 replan
**我的实现:** N 次失败后 throw

**建议:** 添加 replan 逻辑，可配置：
```typescript
interface GateConfig {
  maxFixAttempts: 3,
  replanOnMaxFail: true,  // 新增
  replanThreshold: 3,     // 新增
}
```

### 决策 3: Smoke 实现

**选项 A:** 独立的 SmokeGateService
**选项 B:** 作为 VerificationGateService 的 'smoke' layer

**建议:** 选项 B (保持一致性)，但需要：
- DevServerManager: 管理 dev server 生命周期
- 调用 browser_verify tool

---

## 下一步行动

1. **Phase 0 实现:** 添加 metrics counters 和 run summaries
2. **ProjectDetector 增强:** 添加 smokeCommand, vite 支持
3. **SmokeGate 实现:** 
   - DevServerManager
   - browser_verify 集成
4. **Replan 逻辑:** 失败时调用 Planner

是否批准此分析？批准后开始实施 Phase 0 + Smoke Gate。
