# Conversation Module

Multi-turn conversation system with session management, checkpoints, and slash commands.

## Module Structure

```
conversation/
├── types.ts                   # Core type definitions
├── session-store.ts           # Session persistence
├── prompt-builder.ts          # Prompt context builder
├── conversational-runner.ts   # Main runner with slash commands
└── index.ts                   # Module exports
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ConversationalRunner                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Slash Commands (/undo, /clear, /checkpoints, /continue, /retry)   ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │             SessionState (via SessionStore)                 ││
│  │    sessionId, messages[], checkpoints[], variables{}       ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Orchestrator                             │ │
│  │            Planner → Workers → Results                     │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Slash Commands

| Command                  | Description                       |
| ------------------------ | --------------------------------- |
| `/undo [steps\|id]`      | Roll back to a checkpoint         |
| `/checkpoints`           | List all available checkpoints    |
| `/continue [context]`    | Continue the last unfinished task |
| `/retry [checkpointId]`  | Resume from the latest checkpoint |
| `/clear [--checkpoints]` | Clear conversation history        |
| `/help`                  | Show available commands           |

All other messages are sent to the Orchestrator for AI processing.

## Core Components

| Component                | Responsibility                                          |
| ------------------------ | ------------------------------------------------------- |
| **SessionStore**         | Persist session state: messages, checkpoints, variables |
| **PromptBuilder**        | Manage context window, compress history                 |
| **ConversationalRunner** | Handle messages, slash commands, orchestrate tasks      |

## Usage

```typescript
import { ConversationalRunner } from '@tachikoma/core/conversation';

const runner = new ConversationalRunner({
  sessionDir: './.tachikoma/conversations',
  workDir: process.cwd(),
  llm: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
  },
  enableCheckpoints: true,
});

// Create session
const session = await runner.createSession();

// Handle messages (streaming)
for await (const event of runner.handleMessage(session.sessionId, 'Create a React app')) {
  switch (event.type) {
    case 'thinking':
      console.log('💭', event.content);
      break;
    case 'tool_call':
      console.log('🔧', event.tool);
      break;
    case 'complete':
      console.log('✅', event.summary);
      break;
  }
}

// Use slash commands
for await (const event of runner.handleMessage(session.sessionId, '/undo')) {
  // Rolls back to previous checkpoint
}

for await (const event of runner.handleMessage(session.sessionId, '/clear')) {
  // Clears conversation history
}
```

## Stream Events

| Event Type         | Description            |
| ------------------ | ---------------------- |
| `thinking`         | Agent thinking process |
| `tool_call`        | Tool call request      |
| `tool_result`      | Tool execution result  |
| `subtask_complete` | Subtask completed      |
| `need_user_input`  | User input required    |
| `complete`         | Task completed         |
| `error`            | Error occurred         |

## Features

- ✅ **Multi-turn Iteration** - User can say "make the button bigger"
- ✅ **Slash Commands** - Reliable escape hatch for session control
- ✅ **Checkpoint Undo** - Roll back to previous states
- ✅ **Context Persistence** - Remember variables across turns
- ✅ **Interruptible** - User can interrupt and change direction
- ✅ **History Compression** - Auto-compress long sessions
