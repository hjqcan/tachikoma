# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Build**: `bun run build` (builds all), `bun run build:core` (core only), `bun run build:gateway` (gateway only)
- **Test**: `bun test` (run all tests), `bun test <path/to/test.ts>` (run specific test)
- **Test Coverage**: `bun test --coverage`
- **Lint**: `bun run lint` (check), `bun run lint:fix` (fix)
- **Format**: `bun run format` (write), `bun run format:check` (check)
- **Typecheck**: `bun run typecheck`
- **Dev Server**: `bun run dev` (starts gateway dev server)
- **Clean**: `bun run clean`
- **Run CLI**: `bun run packages/core/bin/tachikoma.ts run --task "TASK" --workdir ./path`
- **SpecKit Init**: `bun run packages/core/bin/tachikoma.ts speckit init --workdir ./path`

## Architecture & Structure

**Tachikoma** is a multi-agent system (MAS) using the Orchestrator-Worker pattern, built with Bun and TypeScript.

### Directory Structure
- `packages/core`: Main logic (Orchestrator, Worker, Tools, Memory, MCP, Collaboration).
- `packages/gateway`: API Gateway and interaction layer.
- `packages/cli`: Standalone CLI package.
- `packages/agentops`: AgentOps dashboard.
- `packages/sandbox`: Dockerfile and sandbox configurations.
- `skills/`: Official skills library.
- `servers/`: MCP server proxies.

### Key Concepts
- **Dual System**:
  - **System 1 (Fast)**: Execution Core & Tools (Worker Agents, Atomic Functions).
  - **System 2 (Slow)**: Orchestration & Planning (Orchestrator, Planner, Task Decomposition).
- **Layers**:
  1. Interaction & Security Gateway
  2. Orchestration & Planning (System 2)
  3. Execution Core & Tools (System 1)
  4. Context & Memory Management
  5. AgentOps & Governance
- **Spec-Driven Development (SpecKit)**: Uses `constitution`, `spec`, `plan`, and `tasks` for structured development.

### Tech Stack
- **Runtime**: Bun
- **Language**: TypeScript 5.0+
- **Communication**: MCP (Model Context Protocol)
- **Storage**: Redis, LevelDB
- **Observability**: OpenTelemetry, Prometheus
