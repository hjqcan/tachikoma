import { describe, it, expect } from 'bun:test';
import {
  ensureTaskmetaV1,
  ensureRoleDefinitions,
  upsertRoleAssignment,
  type TaskmetaFileV1,
  type TaskmetaRoleDefinition,
} from '../src/taskmaster-compat';

describe('taskmaster-compat/taskmeta', () => {
  it('ensureTaskmetaV1: null -> 空 v1；v1 -> 原样返回', () => {
    const created = ensureTaskmetaV1(null);
    expect(created.version).toBe(1);

    const existing: TaskmetaFileV1 = { version: 1, roles: { byId: {} } };
    const same = ensureTaskmetaV1(existing);
    expect(same).toBe(existing);
  });

  it('ensureRoleDefinitions: 只补齐缺失 role，不覆盖已有定义', () => {
    const tm: TaskmetaFileV1 = {
      version: 1,
      roles: {
        byId: {
          frontend: { name: '自定义前端', capabilities: ['role:frontend'], responsibilities: 'custom' },
        },
      },
    };

    const defaults: TaskmetaRoleDefinition[] = [
      { id: 'frontend', name: '前端工程师', capabilities: ['role:frontend'] },
      { id: 'backend', name: '后端工程师', capabilities: ['role:backend'] },
    ];

    const { changed } = ensureRoleDefinitions(tm, defaults);
    expect(changed).toBe(true);
    expect(tm.roles?.byId?.frontend.name).toBe('自定义前端'); // 未被覆盖
    expect(tm.roles?.byId?.backend).toBeDefined(); // 被补齐
  });

  it('upsertRoleAssignment: 只补齐缺失字段，不覆盖已有值', () => {
    const tm: TaskmetaFileV1 = {
      version: 1,
      roles: {
        assignments: {
          master: {
            '1': { roleId: 'frontend' },
          },
        },
      },
    };

    // 首次插入
    const inserted = upsertRoleAssignment(tm, 'conv-1', '2', {
      roleId: 'backend',
      requiredCapabilities: ['role:backend'],
    });
    expect(inserted.changed).toBe(true);
    expect(tm.roles?.assignments?.['conv-1']?.['2']?.roleId).toBe('backend');

    // 不覆盖已有 roleId
    const noOverwrite = upsertRoleAssignment(tm, 'master', '1', {
      roleId: 'test',
      requiredCapabilities: ['role:test'],
    });
    expect(noOverwrite.changed).toBe(true); // 会补齐 requiredCapabilities
    expect(tm.roles?.assignments?.master?.['1']?.roleId).toBe('frontend');
    expect(tm.roles?.assignments?.master?.['1']?.requiredCapabilities).toEqual(['role:test']);
  });
});


