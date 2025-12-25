# Agent Identity Module

> **Letta-Code Inspired Memory-First Architecture**

The Agent Identity module enables Tachikoma to learn, remember, and evolve across
sessions—transforming it from a stateless tool into a learning partner.

## Core Concepts

### 1. Agent Identity

An `AgentIdentity` represents the agent's persistent self across all sessions:

```typescript
interface AgentIdentity {
  id: string; // Unique agent identifier
  coreMemory: CoreMemory; // Learned preferences, patterns, principles
  sessionsCount: number; // Total conversation sessions
  tasksCompleted: number; // Successfully completed tasks
  skillsLearned: string[]; // Skills acquired through learning
}
```

### 2. Core Memory (Letta-Code Style)

```
┌─────────────────────────────────────────────────────┐
│           Core Memory (System Prompt Evolution)     │
│   preferences: User UI/workflow preferences         │
│   workPatterns: Learned work habits                 │
│   systemPrompt: Cross-project guiding principles    │
├─────────────────────────────────────────────────────┤
│           Skills / Memory Blocks                    │
│   .tachikoma/skills/: Reusable task patterns       │
│   project.md: Project-specific context             │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Using /remember Command

```bash
# Auto-detect type and remember
/remember Use TypeScript for all new code

# Explicit types
/remember preference Dark mode for all UIs
/remember pattern Always run tests before committing
/remember principle Be concise in explanations
```

### Using /clear Command

```bash
# Clear conversation (preserves memory/identity)
/clear

# Clear including checkpoints
/clear --checkpoints
```

## Architecture

### System Prompt Injection Order

```
base prompt → identity coreMemory → guides → skills → memory context
```

### Key Components

| Component           | Location                                    | Purpose                                |
| ------------------- | ------------------------------------------- | -------------------------------------- |
| `IdentityLoader`    | `agent-identity/identity.ts`                | Load/save Identity files               |
| `IdentityUpdater`   | `agent-identity/identity.ts`                | Update stats and coreMemory            |
| `CoreMemoryEvolver` | `agent-identity/evolution.ts`               | Learn preferences/patterns/principles  |
| `/remember` command | `conversation/commands/remember-command.ts` | User-guided memory                     |
| `/clear` command    | `conversation/conversational-runner.ts`     | Session reset with memory preservation |

## Storage

### Identity Files

```
~/.tachikoma/agents/
├── default.identity.json     # Default agent identity
├── work.identity.json        # Work-specific agent
└── personal.identity.json    # Personal agent
```

### Memory Blocks (Project-Level)

```
.tachikoma/memory/
├── project.md               # Project context
├── preferences.md           # User preferences
└── skills.md                # Available skills list
```

## Configuration

### GenericAgentBackend

```typescript
const backend = new GenericAgentBackend({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  identityConfig: {
    enabled: true, // Default: true
    agentId: 'my-agent', // Default: from env or 'default'
    agentsDir: '/custom/path', // Default: ~/.tachikoma/agents
    maxFileSize: 102400, // Default: 100KB
  },
});
```

### Environment Variables

```bash
TACHIKOMA_AGENT_ID=my-custom-agent  # Override default agent ID
```

## Security

### Sensitive Data Redaction

All content stored through CoreMemoryEvolver is automatically sanitized:

```typescript
const SENSITIVE_PATTERNS = [
  /\b(sk-[a-zA-Z0-9]{32,})\b/gi, // OpenAI API keys
  /\b(ghp_[a-zA-Z0-9]{36,})\b/gi, // GitHub PAT
  /Bearer\s+[a-zA-Z0-9._-]{20,}/gi, // Bearer tokens
  /-----BEGIN.*PRIVATE KEY-----/gi, // Private keys
  // ... more patterns
];
```

## Comparison with Letta-Code

| Feature            | Letta-Code                 | Tachikoma                     |
| ------------------ | -------------------------- | ----------------------------- |
| Memory Blocks      | ✅ persona/human/project   | ✅ preferences/project/skills |
| Skill Learning     | ✅ `/skill` command        | ✅ Task 17 complete           |
| Core Memory        | ✅ System prompt evolution | ✅ CoreMemoryEvolver          |
| `/remember`        | ✅ User-guided memory      | ✅ Implemented                |
| `/clear` semantics | ✅ Preserve memory         | ✅ Implemented                |
| Multi-Agent        | ❌ Single agent            | ✅ Orchestrator-Workers       |
| Sandbox            | ❌ None                    | ✅ Docker/Local drivers       |

## Automatic Learning

The agent automatically learns from:

1. **Task Success**: `onTaskSuccess()` updates stats and triggers evolution
2. **Skill Learning**: `onSkillLearned()` tracks acquired skills
3. **User Commands**: `/remember` for explicit user guidance

### Learning Triggers

```typescript
// Automatic triggers in CoreMemoryEvolver
onTaskSuccess(objective: string, summary: string): Promise<EvolutionResult>
onSkillLearned(skillId: string): Promise<EvolutionResult>
```

## Migration Guide

### From No Identity to Identity

1. **Automatic**: Identity is created on first use
2. **Manual**: Create `~/.tachikoma/agents/default.identity.json`

```json
{
  "id": "default",
  "coreMemory": {
    "systemPrompt": "",
    "preferences": [],
    "workPatterns": []
  },
  "sessionsCount": 0,
  "tasksCompleted": 0,
  "skillsLearned": []
}
```

## API Reference

### IdentityLoader

```typescript
const loader = new IdentityLoader({ agentsDir: '/path/to/agents' });

// Load identity (returns null if not exists)
const identity = await loader.load('agent-id');

// Load or create with defaults
const identity = await loader.loadOrCreate('agent-id');

// Save identity (atomic write)
await loader.save(identity);
```

### CoreMemoryEvolver

```typescript
const evolver = new CoreMemoryEvolver({ agentsDir: '/path/to/agents' });

// Learn preferences
await evolver.learnPreference('Use dark mode', 'user_command', 'agent-id');

// Learn work patterns
await evolver.learnWorkPattern('Always run tests before commit', 'task_success', 'agent-id');

// Evolve system prompt with principles
await evolver.evolveSystemPrompt(['Be concise'], 'user_command', 'agent-id');
```
