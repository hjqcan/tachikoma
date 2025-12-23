/**
 * Unit tests for Tool Input Validator
 */

import { describe, test, expect } from 'bun:test';
import { validateToolInput, generateValidationError } from '../src/worker/tool-input-validator';

describe('validateToolInput', () => {
  describe('required field validation', () => {
    test('should pass when all required fields are present', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      };
      const result = validateToolInput(schema, { query: 'test' });
      expect(result.valid).toBe(true);
      expect(result.missingRequired).toEqual([]);
    });

    test('should fail when required field is missing', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      };
      const result = validateToolInput(schema, {});
      expect(result.valid).toBe(false);
      expect(result.missingRequired).toContain('query');
    });

    test('should fail when required field is null', () => {
      const schema = {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      };
      const result = validateToolInput(schema, { path: null });
      expect(result.valid).toBe(false);
      expect(result.missingRequired).toContain('path');
    });

    test('should fail when required string field is empty', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      };
      const result = validateToolInput(schema, { query: '' });
      expect(result.valid).toBe(false);
      expect(result.missingRequired).toContain('query');
    });

    test('should handle null input with required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      };
      const result = validateToolInput(schema, null);
      expect(result.valid).toBe(false);
      expect(result.missingRequired).toContain('query');
    });

    test('should handle undefined input with required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      };
      const result = validateToolInput(schema, undefined);
      expect(result.valid).toBe(false);
      expect(result.missingRequired).toContain('query');
    });
  });

  describe('type validation', () => {
    test('should pass for correct string type', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };
      const result = validateToolInput(schema, { name: 'test' });
      expect(result.valid).toBe(true);
    });

    test('should fail for incorrect string type', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };
      const result = validateToolInput(schema, { name: 123 });
      expect(result.valid).toBe(false);
      expect(result.invalidFields.length).toBe(1);
    });

    test('should pass for correct number type', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
      };
      const result = validateToolInput(schema, { count: 42 });
      expect(result.valid).toBe(true);
    });

    test('should fail for incorrect number type', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
      };
      const result = validateToolInput(schema, { count: 'not a number' });
      expect(result.valid).toBe(false);
    });

    test('should validate integer type', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'integer' },
        },
      };
      expect(validateToolInput(schema, { count: 42 }).valid).toBe(true);
      expect(validateToolInput(schema, { count: 42.5 }).valid).toBe(false);
    });

    test('should pass for correct boolean type', () => {
      const schema = {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
        },
      };
      const result = validateToolInput(schema, { enabled: true });
      expect(result.valid).toBe(true);
    });

    test('should pass for correct array type', () => {
      const schema = {
        type: 'object',
        properties: {
          items: { type: 'array' },
        },
      };
      const result = validateToolInput(schema, { items: [1, 2, 3] });
      expect(result.valid).toBe(true);
    });
  });

  describe('constraint validation', () => {
    test('should validate minimum constraint', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number', minimum: 1 },
        },
      };
      expect(validateToolInput(schema, { count: 5 }).valid).toBe(true);
      expect(validateToolInput(schema, { count: 0 }).valid).toBe(false);
    });

    test('should validate maximum constraint', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number', maximum: 100 },
        },
      };
      expect(validateToolInput(schema, { count: 50 }).valid).toBe(true);
      expect(validateToolInput(schema, { count: 150 }).valid).toBe(false);
    });

    test('should validate minLength constraint', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 3 },
        },
      };
      expect(validateToolInput(schema, { name: 'abc' }).valid).toBe(true);
      expect(validateToolInput(schema, { name: 'ab' }).valid).toBe(false);
    });

    test('should validate maxLength constraint', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 10 },
        },
      };
      expect(validateToolInput(schema, { name: 'short' }).valid).toBe(true);
      expect(validateToolInput(schema, { name: 'this is a very long name' }).valid).toBe(false);
    });

    test('should validate enum constraint', () => {
      const schema = {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'inactive', 'pending'] },
        },
      };
      expect(validateToolInput(schema, { status: 'active' }).valid).toBe(true);
      expect(validateToolInput(schema, { status: 'unknown' }).valid).toBe(false);
    });
  });

  describe('hint generation', () => {
    test('should generate hint for missing required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query', 'limit'],
      };
      const result = validateToolInput(schema, {});
      expect(result.hint).toContain('Missing required parameters');
    });

    test('should generate hint for invalid fields', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
      };
      const result = validateToolInput(schema, { count: 'not a number' });
      expect(result.hint).toContain('Invalid values');
    });
  });
});

describe('generateValidationError', () => {
  test('should generate structured error response', () => {
    const validation = {
      valid: false,
      missingRequired: ['query'],
      invalidFields: [],
      hint: 'Missing required parameters: query',
    };
    const output = generateValidationError('knowledge_retrieval', validation);
    const parsed = JSON.parse(output);
    
    expect(parsed.success).toBe(false);
    expect(parsed.tool).toBe('knowledge_retrieval');
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.missingRequired).toContain('query');
  });

  test('should include available parameters when schema provided', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number' },
      },
      required: ['query'],
    };
    const validation = {
      valid: false,
      missingRequired: ['query'],
      invalidFields: [],
    };
    const output = generateValidationError('search', validation, schema);
    const parsed = JSON.parse(output);
    
    expect(parsed.availableParameters).toBeDefined();
    expect(parsed.availableParameters.length).toBe(2);
  });
});