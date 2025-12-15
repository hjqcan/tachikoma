---
name: speckit
title: 'SpecKit - Spec-Driven Development'
description: |
  SpecKit enables Spec-Driven Development workflow in Tachikoma.

  Commands:
  - /speckit.init - Initialize SpecKit directory structure
  - /speckit.constitution - Create or update project constitution
  - /speckit.specify - Create functional specification from requirements
  - /speckit.plan - Generate implementation plan from specification
  - /speckit.tasks - Break down plan into actionable tasks
  - /speckit.status - Check workflow progress

category: workflow
version: '1.0.0'
author: Tachikoma
---

# SpecKit Skill

Enables Spec-Driven Development (SDD) workflow for structured project development.

> Note: In this repo, SpecKit is currently integrated for internal usage.
> The CLI provides `tachikoma speckit init` to scaffold directories. The remaining steps are
> workflow guidance and APIs (`SpecKitWorkflow`) you can call from code; they are not exposed as
> first-class CLI subcommands yet.

## Workflow

```
Constitution → Specify → Plan → Tasks → Implement
```

## Commands

### `tachikoma speckit init`

Initialize SpecKit directory structure in the current project.

```bash
tachikoma speckit init --workdir .
```

Creates:

- `.tachikoma/speckit/memory/` - Project constitution
- `.tachikoma/speckit/specs/` - Feature specifications
- `.tachikoma/speckit/templates/` - Templates

### `/speckit.constitution` (workflow guidance)

Create or update project constitution with governance principles.

**Usage:**

```
/speckit.constitution Create principles for a React + TypeScript project with TDD
```

**Output:** `.tachikoma/speckit/memory/constitution.md`

### `/speckit.specify` (workflow guidance)

Create a functional specification from natural language requirements.

**Usage:**

```
/speckit.specify Add user authentication with email/password and OAuth
```

**Output:** `.tachikoma/speckit/specs/{id}/spec.md`

### `/speckit.plan` (workflow guidance)

Generate implementation plan with tech stack and phases.

**Usage:**

```
/speckit.plan {spec-id} Use Next.js 14, Supabase, and Tailwind
```

**Output:** `.tachikoma/speckit/specs/{id}/plan.md`

### `/speckit.tasks` (workflow guidance)

Break down plan into actionable tasks with dependencies.

**Usage:**

```
/speckit.tasks {spec-id} --tdd
```

**Output:** `.tachikoma/speckit/specs/{id}/tasks.md`

### `/speckit.status` (workflow guidance)

Check workflow progress for a specification.

**Usage:**

```
/speckit.status {spec-id}
```

## API Usage

```typescript
	import { SpecKitWorkflow, createSpecKitFileManager } from '@tachikoma/core';

	const fileManager = createSpecKitFileManager({ workDir: '.' });
	await fileManager.init();

const workflow = new SpecKitWorkflow({ llmClient, fileManager });

// Step 1: Constitution
await workflow.constitution('Create React project principles');

// Step 2: Specification
const specResult = await workflow.specify('Add user auth');

// Step 3: Plan
await workflow.plan(specResult.data.id, 'Use Next.js + Supabase');

// Step 4: Tasks
await workflow.tasks(specResult.data.id, true /* useTDD */);
```

## Orchestrator Integration

```typescript
	import { SpecKitOrchestratorHelper } from '@tachikoma/core';

const helper = new SpecKitOrchestratorHelper({ fileManager });

// Validate spec completeness
const validation = await helper.validateSpec('001-feature');

// Convert to Orchestrator SubTasks
const output = await helper.convertSpecToSubtasks('001-feature');

// Track progress
const progress = await helper.getSpecProgress('001-feature');
```
