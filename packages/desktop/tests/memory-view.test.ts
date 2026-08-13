import { describe, expect, it } from 'bun:test';

import {
  buildMemoryView,
  feedbackLifecycleLabel,
  systemRecordsSummary,
} from '../src/renderer/memory-view';

describe('memory drawer view policy', () => {
  const feedback = {
    id: 'feedback-1',
    type: 'feedback',
    content: '回答时先给结论',
    lifecycle: 'superseded' as const,
  };
  const experience = {
    id: 'experience-1',
    type: 'experience',
    content: 'Recall rules-only returned 0 hit(s).',
  };

  it('keeps system experiences auditable but outside the user-memory empty state', () => {
    expect(buildMemoryView([experience], false)).toEqual({
      userGroups: [],
      experiences: [experience],
      expandExperiences: false,
      userMemoryEmpty: true,
    });
  });

  it('expands the experience details when search returned experience matches', () => {
    expect(buildMemoryView([feedback, experience], true)).toMatchObject({
      experiences: [experience],
      expandExperiences: true,
      userMemoryEmpty: false,
    });
  });

  it('labels the folded experience group as system records', () => {
    expect(systemRecordsSummary(2)).toBe('系统记录 · 2');
  });

  it('maps feedback lifecycle to concise badges', () => {
    expect(feedbackLifecycleLabel('active')).toBe('生效中');
    expect(feedbackLifecycleLabel('superseded')).toBe('已替代');
    expect(feedbackLifecycleLabel('inactive')).toBe('已停用');
    expect(feedbackLifecycleLabel(undefined)).toBeUndefined();
  });
});
