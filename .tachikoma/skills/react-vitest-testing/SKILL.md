---
name: react-vitest-testing
description:
  Complete guide and templates for React component testing with Vitest and Testing Library. Includes
  TypeScript configuration, mock patterns, and contract-first testing practices.
license: MIT
---

# React + Vitest Testing

This skill provides templates and guidance for writing correct React component tests with Vitest.

## CRITICAL: Contract-First Testing

**Before writing ANY test file:**

1. **FIRST read the component file** to get the exact interface/props
2. **Write test using ONLY the props that actually exist**
3. **NEVER assume props** - if the component doesn't have `onSearch`, don't use it in tests

### Workflow Example

```
1. Read component: file_read('src/components/Header.tsx')
   → See: interface HeaderProps { title?: string; subtitle?: string; }

2. Write test with ONLY those props:
   render(<Header title="Test" subtitle="Subtitle" />)  ✅

3. DON'T use imaginary props:
   render(<Header onSearch={mockFn} />)  ❌ ERROR if HeaderProps doesn't have onSearch
```

## Required TypeScript Configuration

Your `tsconfig.json` MUST include vitest types:

```json
{
  "compilerOptions": {
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  }
}
```

**Without this, you get: "Cannot find name 'beforeEach'"**

## Required Test File Imports

Every test file MUST have these imports:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
```

## vitest.config.ts Template

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

## test-setup.ts Template

```typescript
import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock IntersectionObserver
globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock ResizeObserver
globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));
```

## Mock Type Safety

When mocking, always use proper types:

```typescript
// ❌ WRONG - TypeScript doesn't know about mock methods
vi.mock('./api', () => ({ fetchData: vi.fn() }));
api.fetchData.mockResolvedValue(data); // Error: mockResolvedValue doesn't exist

// ✅ CORRECT - Use Mock type
import type { Mock } from 'vitest';
vi.mock('./api', () => ({
  fetchData: vi.fn() as Mock<[id: string], Promise<Data>>,
}));

// Or cast when using:
(api.fetchData as Mock).mockResolvedValue(data);
```

## Test File Location

Tests MUST be co-located with source files:

```
src/
  components/
    Header.tsx
    Header.test.tsx     ✅ Correct
```

**NEVER use `__tests__` folders** - they break imports!

## Required Dependencies

```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event @vitejs/plugin-react jsdom
```

## Common Mistakes to Avoid

| Mistake                               | Error                         | Fix                                                 |
| ------------------------------------- | ----------------------------- | --------------------------------------------------- |
| Not reading component first           | Props don't match             | Always file_read component before testing           |
| Missing vitest/globals type           | Cannot find name 'beforeEach' | Add to tsconfig types                               |
| Not importing userEvent               | Cannot find name 'userEvent'  | import userEvent from '@testing-library/user-event' |
| Using mockResolvedValue on untyped fn | Property doesn't exist        | Cast to Mock type                                   |
| Using **tests** folder                | Failed to resolve import      | Co-locate tests with source                         |
