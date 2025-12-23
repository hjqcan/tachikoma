import { describe, test, expect } from 'bun:test';
import { deriveConstraintPolicy } from '../src/worker/engines/constraint-guard';

describe('constraint-guard', () => {
  test('should treat "no react" as negation', () => {
    const policy = deriveConstraintPolicy(['no react']);
    expect(policy.disallowedFrontendFamilies.has('react')).toBe(true);
    expect(policy.allowedFrontendFamilies.has('react')).toBe(false);
  });

  test('should not treat "unknown react" as negation (avoid "no" substring false positive)', () => {
    const policy = deriveConstraintPolicy(['unknown react']);
    expect(policy.allowedFrontendFamilies.has('react')).toBe(true);
    expect(policy.disallowedFrontendFamilies.has('react')).toBe(false);
  });

  test('should treat "do not use react" as negation', () => {
    const policy = deriveConstraintPolicy(['do not use react']);
    expect(policy.disallowedFrontendFamilies.has('react')).toBe(true);
  });
});


