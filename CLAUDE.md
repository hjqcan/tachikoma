# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Commands

- **Build**: `bun run build` (builds all), `bun run build:core` (core only), `bun run build:gateway`
  (gateway only)
- **Test**: `bun test` (run all tests), `bun test <path/to/test.ts>` (run specific test)
- **Test Coverage**: `bun test --coverage`
- **Lint**: `bun run lint` (check), `bun run lint:fix` (fix)
- **Format**: `bun run format` (write), `bun run format:check` (check)
- **Typecheck**: `bun run typecheck`
- **Dev Server**: `bun run dev` (starts gateway dev server)
- **Clean**: `bun run clean`
- **Run CLI**: `bun run packages/core/bin/tachikoma.ts run --task "TASK" --workdir ./path`
- **Legacy orchestration CLI**:
  `bun run packages/core/bin/tachikoma.ts orchestrate --task "TASK" --workdir ./path`
- **SpecKit Init**: `bun run packages/core/bin/tachikoma.ts speckit init --workdir ./path`

## Architecture & Structure

**Tachikoma** is a conversation-first coding agent built with Bun and TypeScript. The default `chat`
and `run` paths share `ChatEngine` and use pi-mono directly for the model/tool loop and coding
tools. The older Orchestrator-Worker system is an explicit `orchestrate` compatibility path.

### Directory Structure

- `packages/core`: Main logic (Orchestrator, Worker, Tools, Memory, MCP, Collaboration).
- `packages/gateway`: API Gateway and interaction layer.
- `packages/cli`: Standalone CLI package.
- `packages/agentops`: AgentOps dashboard.
- `packages/sandbox`: Dockerfile and sandbox configurations.
- `skills/`: Official skills library.
- `servers/`: MCP server proxies.

### Key Concepts

- **Default execution**: `ChatEngine` -> `@earendil-works/pi-agent-core` -> pi coding tools.
- **Legacy orchestration**: `ConversationalRunner` -> Orchestrator -> Worker backends, only through
  `orchestrate` and eval flows.
- **Dual System**:
  - **System 1 (Fast)**: Execution Core & Tools (Worker Agents, Atomic Functions).
  - **System 2 (Slow)**: Orchestration & Planning (Orchestrator, Planner, Task Decomposition).
- **Layers**:
  1. Interaction & Security Gateway
  2. Orchestration & Planning (System 2)
  3. Execution Core & Tools (System 1)
  4. Context & Memory Management
  5. AgentOps & Governance
- **Spec-Driven Development (SpecKit)**: Uses `constitution`, `spec`, `plan`, and `tasks` for
  structured development.

### Tech Stack

- **Runtime**: Bun 1.3.14+
- **Language**: TypeScript 6.0
- **Communication**: MCP (Model Context Protocol)
- **Storage**: Redis, LevelDB
- **Observability**: OpenTelemetry, Prometheus
