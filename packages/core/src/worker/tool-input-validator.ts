/**
 * Tool Input Validator
 *
 * Validates tool input parameters against JSON Schema before execution.
 * This catches missing required parameters early and provides helpful error messages,
 * preventing wasted turns on invalid tool calls.
 */

/**
 * Result of input validation
 */
export interface ValidationResult {
  /** Whether the input is valid */
  valid: boolean;
  /** List of missing required fields */
  missingRequired: string[];
  /** List of invalid field values with reasons */
  invalidFields: { field: string; reason: string }[];
  /** Human-readable hint for fixing the issue */
  hint?: string | undefined;
}

/**
 * JSON Schema definition (subset of full JSON Schema)
 */
export interface JSONSchemaDefinition {
  type?: string;
  properties?: Record<string, JSONSchemaDefinition>;
  required?: string[];
  items?: JSONSchemaDefinition;
  enum?: unknown[];
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/**
 * Validates tool input against a JSON Schema
 *
 * @param schema - JSON Schema to validate against
 * @param input - Input to validate
 * @returns Validation result with details on missing/invalid fields
 *
 * @example
 * ```typescript
 * const schema = {
 *   type: 'object',
 *   properties: {
 *     query: { type: 'string', description: 'Search query' },
 *     limit: { type: 'number' },
 *   },
 *   required: ['query'],
 * };
 *
 * const result = validateToolInput(schema, {});
 * // { valid: false, missingRequired: ['query'], invalidFields: [] }
 * ```
 */
export function validateToolInput(
  schema: JSONSchemaDefinition | Record<string, unknown>,
  input: unknown
): ValidationResult {
  const typedSchema = schema as JSONSchemaDefinition;

  // Default to valid
  const result: ValidationResult = {
    valid: true,
    missingRequired: [],
    invalidFields: [],
  };

  // Handle null/undefined input
  if (input === null || input === undefined) {
    const required = typedSchema.required || [];
    if (required.length > 0) {
      result.valid = false;
      result.missingRequired = [...required];
      result.hint = `This tool requires: ${required.join(', ')}`;
    }
    return result;
  }

  // Input must be an object for object schemas
  if (typedSchema.type === 'object' || typedSchema.properties) {
    if (typeof input !== 'object' || Array.isArray(input)) {
      result.valid = false;
      result.invalidFields.push({
        field: '(root)',
        reason: 'Expected an object',
      });
      return result;
    }

    const inputObj = input as Record<string, unknown>;
    const properties = typedSchema.properties || {};
    const required = typedSchema.required || [];

    // Check required fields
    for (const field of required) {
      const value = inputObj[field];
      if (value === undefined || value === null) {
        result.valid = false;
        result.missingRequired.push(field);
      } else if (typeof value === 'string' && value.trim() === '') {
        // Empty strings are considered missing for required fields
        result.valid = false;
        result.missingRequired.push(field);
        result.invalidFields.push({
          field,
          reason: 'Cannot be empty string',
        });
      }
    }

    // Check field types
    for (const [field, fieldSchema] of Object.entries(properties)) {
      const value = inputObj[field];
      if (value === undefined || value === null) {
        continue; // Already handled in required check
      }

      const fieldValidation = validateFieldType(field, value, fieldSchema);
      if (!fieldValidation.valid) {
        result.valid = false;
        result.invalidFields.push(...fieldValidation.errors);
      }
    }

    // Generate hint if there are issues
    if (!result.valid) {
      const hints: string[] = [];
      if (result.missingRequired.length > 0) {
        hints.push(`Missing required parameters: ${result.missingRequired.join(', ')}`);
      }
      if (result.invalidFields.length > 0) {
        hints.push(
          `Invalid values: ${result.invalidFields.map((f) => `${f.field} (${f.reason})`).join(', ')}`
        );
      }
      result.hint = hints.join('. ');
    }
  }

  return result;
}

/**
 * Validates a single field value against its schema
 */
function validateFieldType(
  field: string,
  value: unknown,
  schema: JSONSchemaDefinition
): { valid: boolean; errors: { field: string; reason: string }[] } {
  const errors: { field: string; reason: string }[] = [];

  if (!schema.type) {
    return { valid: true, errors: [] };
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push({ field, reason: `Expected string, got ${typeof value}` });
      } else {
        // Check string constraints
        if (schema.minLength && value.length < schema.minLength) {
          errors.push({ field, reason: `Must be at least ${schema.minLength} characters` });
        }
        if (schema.maxLength && value.length > schema.maxLength) {
          errors.push({ field, reason: `Must be at most ${schema.maxLength} characters` });
        }
        if (schema.pattern) {
          const regex = new RegExp(schema.pattern);
          if (!regex.test(value)) {
            errors.push({ field, reason: `Must match pattern ${schema.pattern}` });
          }
        }
      }
      break;

    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({ field, reason: `Expected number, got ${typeof value}` });
      } else {
        if (schema.type === 'integer' && !Number.isInteger(value)) {
          errors.push({ field, reason: 'Must be an integer' });
        }
        if (schema.minimum !== undefined && value < schema.minimum) {
          errors.push({ field, reason: `Must be >= ${schema.minimum}` });
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
          errors.push({ field, reason: `Must be <= ${schema.maximum}` });
        }
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push({ field, reason: `Expected boolean, got ${typeof value}` });
      }
      break;

    case 'array':
      if (!Array.isArray(value)) {
        errors.push({ field, reason: `Expected array, got ${typeof value}` });
      }
      break;

    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push({ field, reason: `Expected object, got ${typeof value}` });
      }
      break;
  }

  // Check enum constraint
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ field, reason: `Must be one of: ${schema.enum.join(', ')}` });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Generates a helpful message for tool input validation failures
 *
 * @param toolName - Name of the tool
 * @param validation - Validation result
 * @param schema - Original schema for context
 * @returns Structured error response for the LLM
 */
export function generateValidationError(
  toolName: string,
  validation: ValidationResult,
  schema?: JSONSchemaDefinition | Record<string, unknown>
): string {
  const typedSchema = schema as JSONSchemaDefinition | undefined;
  const response: Record<string, unknown> = {
    success: false,
    error: 'Invalid tool input',
    tool: toolName,
    code: 'VALIDATION_ERROR',
  };

  if (validation.missingRequired.length > 0) {
    response.missingRequired = validation.missingRequired;
  }

  if (validation.invalidFields.length > 0) {
    response.invalidFields = validation.invalidFields;
  }

  if (validation.hint) {
    response.hint = validation.hint;
  }

  // Add available parameters as context
  if (typedSchema?.properties) {
    const params = Object.entries(typedSchema.properties).map(([name, prop]) => {
      const fieldSchema = prop as JSONSchemaDefinition;
      const isRequired = typedSchema.required?.includes(name);
      return {
        name,
        type: fieldSchema.type || 'any',
        required: isRequired,
        description: fieldSchema.description,
      };
    });
    response.availableParameters = params;
  }

  return JSON.stringify(response, null, 2);
}