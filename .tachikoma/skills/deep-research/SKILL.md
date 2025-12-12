---
name: deep-research
description: |
  当任务需要在公开网络上进行长时、多轮资料检索、阅读、对比与综合，并产出带引用（citations）的报告时使用本技能。
  优先调用 deep_research 工具，而不是手动多次 web_search / browser_*。
license: MIT
---

## 目的

帮助智能体识别“深度公开网研究”场景，并正确使用 `deep_research` 工具获取高质量、带引用的长报告。

## 何时使用

在子任务/用户目标满足以下任一情况时，优先使用 `deep_research`：

- 需要大量公开网络信息（新闻、论文、产品对比、最佳实践、生态调研等）
- 需要多来源交叉验证，并输出引用来源
- 任务时延允许（分钟级），不要求低延迟

## 何时不要使用

- 任务需要自定义工具 / MCP / 沙盒执行 / 本地代码或私有数据强耦合
- 只需少量快速搜索或已有明确来源

## 如何调用工具

工具名：`deep_research`  
必填输入：`input`（研究问题/任务描述）

可选输入：
- `agent`：默认 `deep-research-pro-preview-12-2025`
- `agentConfig`：透传 `agent_config`（如 `{ type: "deep-research", thinking_summaries: "auto" }`）
- `previousInteractionId`：用于 follow-up 研究
- `timeoutMs`、`pollIntervalMs`：控制最长等待与轮询间隔

示例：

```xml
<tool_use>
<name>deep_research</name>
<input>{"input":"比较 2025 年主流 agent 框架（LangChain, AutoGen, Tachikoma）的架构与优缺点，并给出引用来源。","agentConfig":{"type":"deep-research","thinking_summaries":"auto"}}</input>
</tool_use>
```

## 输出解读

工具会返回：

- `report`：最终研究报告（字符串）
- `citations`：引用来源列表（用于核验与溯源）
- `raw`：Interactions API 原始响应

当 `success=false` 但有 `data` 时，通常是超时/失败，可根据 `status` 和 `raw` 进一步排查。
