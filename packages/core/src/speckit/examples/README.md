# SpecKit Usage Examples

This directory contains examples demonstrating how to use the SpecKit module for Spec-Driven
Development.

## Quick Start

```typescript
import {
  createSpecKitFileManager,
  SpecKitWorkflow,
  type SpecKitWorkflowConfig,
} from '@tachikoma/core';
import { createLLMClient } from '@tachikoma/core';

// 1. Create LLM client
const llmClient = createLLMClient({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
});

// 2. Create file manager
const fileManager = createSpecKitFileManager({
  workDir: process.cwd(),
});

// 3. Initialize SpecKit directory
await fileManager.init();

// 4. Create workflow
const workflow = new SpecKitWorkflow({ llmClient, fileManager });
```

## Complete Workflow Example

```typescript
// Step 1: Create project constitution
const constitutionResult = await workflow.constitution(`
  This is a React + TypeScript project.
  We use Tailwind CSS for styling.
  We follow TDD practices.
`);

console.log('Constitution created:', constitutionResult.filePath);

// Step 2: Create a specification
const specResult = await workflow.specify(`
  Add user authentication with:
  - Email/password login
  - Password reset
  - Remember me functionality
`);

console.log('Specification created:', specResult.filePath);
const specId = specResult.data?.id;

// Step 3: Generate implementation plan
const planResult = await workflow.plan(
  specId!,
  `
  Use Next.js 14 with App Router
  Use Supabase for backend
  Use React Hook Form for forms
`
);

console.log('Plan created:', planResult.filePath);

// Step 4: Generate task breakdown
const tasksResult = await workflow.tasks(specId!, true /* useTDD */);

console.log('Tasks created:', tasksResult.filePath);
console.log('Total tasks:', tasksResult.data?.tasks.length);
```

## File Manager Operations

```typescript
// List all specifications
const specs = await fileManager.listSpecs();
console.log('Specs:', specs);

// Read a specification
const spec = await fileManager.readSpec('001-user-auth');
console.log('Spec name:', spec?.name);

// Update task status
await fileManager.updateTaskStatus('001-user-auth', 'task-1', 'done');

// Clean up (delete a spec)
await fileManager.deleteSpec('001-user-auth');
```

## Templates

```typescript
import { loadTemplate, renderTemplate } from '@tachikoma/core';

// Load a template
const template = await loadTemplate('constitution');

// Render with variables
const rendered = renderTemplate(template, {
  PROJECT_NAME: 'My App',
  TECH_STACK: 'React + Node.js',
});
```

## CLI Usage

```bash
# Initialize SpecKit
tachikoma speckit init --workdir ./my-project

# Show help
tachikoma speckit help
```

## Directory Structure

After initialization, your project will have:

```
my-project/
└── .tachikoma/
    └── speckit/
        ├── memory/
        │   └── constitution.md
        ├── specs/
        │   └── 001-user-auth/
        │       ├── spec.md
        │       ├── plan.md
        │       └── tasks.md
        └── templates/
```
