import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readTasksJson,
  writeTasksJson,
  moveTasksJsonTag,
  updateTaskOrSubtaskStatus,
  addTaskOrSubtaskDependency,
  expandTaskOrSubtask,
  type Task,
  type TaskMetadata,
} from '../src/taskmaster-compat';

const TEST_ROOT = '.tachikoma-test-taskmaster';

async function cleanup(): Promise<void> {
  if (existsSync(TEST_ROOT)) {
    await rm(TEST_ROOT, { recursive: true, force: true });
  }
}

function makeTask(overrides: Partial<Task> & { id: string; title: string; description: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.description,
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'medium',
    dependencies: overrides.dependencies ?? [],
    details: overrides.details ?? '',
    testStrategy: overrides.testStrategy ?? '',
    subtasks: overrides.subtasks ?? [],
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  };
}

function makeMetadata(): TaskMetadata {
  return {
    version: '1.0.0',
    lastModified: new Date().toISOString(),
    taskCount: 0,
    completedCount: 0,
    tags: ['master'],
  };
}

describe('taskmaster-compat/tasks-json-io', () => {
  beforeEach(async () => {
    await cleanup();
    await mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('应能读取 standard 格式 tasks.json（顶层 tasks/metadata）', async () => {
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });
    await writeFile(
      tasksPath,
      JSON.stringify(
        {
          tasks: [makeTask({ id: '1', title: 'T1', description: 'D1' })],
          metadata: { ...makeMetadata(), taskCount: 1 },
        },
        null,
        2
      ),
      'utf-8'
    );

    const res = await readTasksJson({ projectRoot: TEST_ROOT });
    expect(res.format).toBe('standard');
    expect(res.tag).toBe('master');
    expect(res.tasks.length).toBe(1);
    expect(res.tasks[0].id).toBe('1');
  });

  it('standard 格式下读取非 master tag 应视为空（避免误读 master 计划）', async () => {
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });
    await writeFile(
      tasksPath,
      JSON.stringify(
        {
          tasks: [makeTask({ id: '1', title: 'T1', description: 'D1' })],
          metadata: { ...makeMetadata(), taskCount: 1 },
        },
        null,
        2
      ),
      'utf-8'
    );

    const res = await readTasksJson({ projectRoot: TEST_ROOT, tag: 'conv-1234' });
    expect(res.format).toBe('standard');
    expect(res.tag).toBe('conv-1234');
    expect(res.tasks.length).toBe(0);
  });

  it('应能读取 legacy(tag 容器) 格式 tasks.json，并保留 rawData 以便写回不丢其他 tag', async () => {
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });
    await writeFile(
      tasksPath,
      JSON.stringify(
        {
          master: {
            tasks: [makeTask({ id: '1', title: 'T1', description: 'D1' })],
            metadata: { ...makeMetadata(), taskCount: 1 },
          },
          feature: {
            tasks: [makeTask({ id: '9', title: 'T9', description: 'D9' })],
            metadata: { ...makeMetadata(), taskCount: 1, tags: ['feature'] },
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    const res = await readTasksJson({ projectRoot: TEST_ROOT, tag: 'master' });
    expect(res.format).toBe('legacy');
    expect(res.tag).toBe('master');
    expect(res.rawData.feature.tasks[0].id).toBe('9');

    // 写回 master，不应覆盖 feature
    await writeTasksJson({
      projectRoot: TEST_ROOT,
      tag: 'master',
      rawData: res.rawData,
      tasks: [
        makeTask({ id: '1', title: 'T1', description: 'D1', status: 'in-progress' }),
      ],
    });

    const after = JSON.parse(await readFile(tasksPath, 'utf-8'));
    expect(after.feature.tasks[0].id).toBe('9');
    expect(after.master.tasks[0].status).toBe('in-progress');
  });

  it('应能把一个 tag 迁移为 archive tag（不覆盖其他 tag）', async () => {
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });

    await writeFile(
      tasksPath,
      JSON.stringify(
        {
          'conv-aaaa': {
            tasks: [makeTask({ id: '1', title: 'T1', description: 'D1', status: 'done' })],
            metadata: { ...makeMetadata(), taskCount: 1, tags: ['conv-aaaa'] },
          },
          keep: {
            tasks: [makeTask({ id: '9', title: 'T9', description: 'D9', status: 'pending' })],
            metadata: { ...makeMetadata(), taskCount: 1, tags: ['keep'] },
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    const moved = await moveTasksJsonTag({
      projectRoot: TEST_ROOT,
      file: '.taskmaster/tasks/tasks.json',
      fromTag: 'conv-aaaa',
      toTag: 'archive-202512-conv-aaaa',
    });
    expect(moved.moved).toBe(true);

    const after = JSON.parse(await readFile(tasksPath, 'utf-8'));
    expect(after.keep.tasks[0].id).toBe('9');
    expect(after['archive-202512-conv-aaaa'].tasks[0].id).toBe('1');
    expect(after['conv-aaaa']).toBeUndefined();
  });

  it('应能更新 subtask 状态，并按上游逻辑 auto-adjust parent status', async () => {
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });

    const t1: Task = makeTask({
      id: '1',
      title: 'Parent',
      description: 'Parent desc',
      status: 'pending',
      subtasks: [
        {
          id: 1,
          parentId: '1',
          title: 'S1',
          description: 'S1 desc',
          status: 'pending',
          priority: 'medium',
          dependencies: [],
          details: '',
          testStrategy: '',
        },
      ],
    });

    await writeFile(
      tasksPath,
      JSON.stringify(
        {
          tasks: [t1],
          metadata: { ...makeMetadata(), taskCount: 1 },
        },
        null,
        2
      ),
      'utf-8'
    );

    await updateTaskOrSubtaskStatus('1.1', 'in-progress', { projectRoot: TEST_ROOT });

    const after = JSON.parse(await readFile(tasksPath, 'utf-8'));
    expect(after.tasks[0].subtasks[0].status).toBe('in-progress');
    // anyInProgress -> parent in-progress
    expect(after.tasks[0].status).toBe('in-progress');
  });

  it('应能在二级层面继续细分并写回 tasks.json（不生成 1.1.1：改写 1.1 为 part1 + 新增 1.2）', async () => {
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });

    const t1: Task = makeTask({
      id: '1',
      title: 'Parent',
      description: 'Parent desc',
      status: 'in-progress',
      subtasks: [
        {
          id: 1,
          parentId: '1',
          title: 'S1',
          description: 'S1 desc',
          status: 'pending',
          priority: 'medium',
          dependencies: [],
          details: '',
          testStrategy: '',
        },
      ],
    });

    await writeFile(
      tasksPath,
      JSON.stringify(
        {
          tasks: [t1],
          metadata: { ...makeMetadata(), taskCount: 1 },
        },
        null,
        2
      ),
      'utf-8'
    );

    await expandTaskOrSubtask(
      '1.1',
      [
        { title: 'C1', description: 'C1 desc', details: 'd1', testStrategy: 't1' },
        { title: 'C2', description: 'C2 desc', details: 'd2', testStrategy: 't2' },
      ],
      { projectRoot: TEST_ROOT }
    );

    const after = JSON.parse(await readFile(tasksPath, 'utf-8'));
    const subs = after.tasks[0].subtasks;
    // 不生成 1.1.1：保留原 subtask(1) 作为 part1，并新增兄弟 subtask(2) 作为 part2
    expect(subs.length).toBe(2);
    expect(subs[0].id).toBe(1);
    expect(subs[1].id).toBe(2);
    expect(subs[0].title).toBe('C1');
    expect(subs[1].title).toBe('C2');
  });

  it('二级继续细分时应把下游依赖从原 1.1 迁移到最后一个新增 part（方案A）', async () => {
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });

    const t1: Task = makeTask({
      id: '1',
      title: 'Parent',
      description: 'Parent desc',
      status: 'in-progress',
      subtasks: [
        {
          id: 1,
          parentId: '1',
          title: 'S1',
          description: 'S1 desc',
          status: 'pending',
          priority: 'medium',
          dependencies: [],
          details: '',
          testStrategy: '',
        },
        {
          id: 2,
          parentId: '1',
          title: 'S2',
          description: 'S2 desc',
          status: 'pending',
          priority: 'medium',
          dependencies: ['1'], // 下游原本依赖 1.1（同级引用；类型为 string[]）
          details: '',
          testStrategy: '',
        },
      ],
    });

    await writeFile(
      tasksPath,
      JSON.stringify(
        {
          tasks: [t1],
          metadata: { ...makeMetadata(), taskCount: 1 },
        },
        null,
        2
      ),
      'utf-8'
    );

    await expandTaskOrSubtask(
      '1.1',
      [
        { title: 'Part1', description: 'P1', details: 'd1', testStrategy: 't1' },
        { title: 'Part2', description: 'P2', details: 'd2', testStrategy: 't2' },
        { title: 'Part3', description: 'P3', details: 'd3', testStrategy: 't3' },
      ],
      { projectRoot: TEST_ROOT }
    );

    const after = JSON.parse(await readFile(tasksPath, 'utf-8'));
    const subs = after.tasks[0].subtasks;
    expect(subs.length).toBe(4);

    const s2 = subs.find((s: any) => s.id === 2);
    expect(s2).toBeDefined();
    // 依赖从 1.1 迁移到最后 part：因为新增了 id=3,4，所以最后 fullId 为 1.4
    expect(s2.dependencies).toEqual(['1.4']);

    const s3 = subs.find((s: any) => s.id === 3);
    const s4 = subs.find((s: any) => s.id === 4);
    expect(s3.dependencies).toEqual(['1.1']);
    expect(s4.dependencies).toEqual(['1.3']);
  });

  it('expand task 时应支持默认串行/显式并行策略', async () => {
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });

    const t1: Task = makeTask({
      id: '1',
      title: 'T1',
      description: 'D1',
      status: 'pending',
      subtasks: [],
    });

    await writeFile(
      tasksPath,
      JSON.stringify(
        {
          tasks: [t1],
          metadata: { ...makeMetadata(), taskCount: 1 },
        },
        null,
        2
      ),
      'utf-8'
    );

    await expandTaskOrSubtask(
      '1',
      [
        { title: 'A', description: 'A desc', details: '', testStrategy: '' },
        { title: 'B', description: 'B desc', details: '', testStrategy: '' },
        { title: 'C', description: 'C desc', details: '', testStrategy: '' },
      ],
      { projectRoot: TEST_ROOT, strategy: 'serial' }
    );

    let after = JSON.parse(await readFile(tasksPath, 'utf-8'));
    let subs = after.tasks[0].subtasks;
    expect(subs.length).toBe(3);
    expect(subs[0].dependencies).toEqual([]);
    expect(subs[1].dependencies).toEqual(['1.1']);
    expect(subs[2].dependencies).toEqual(['1.2']);

    // 强制替换为 parallel
    await expandTaskOrSubtask(
      '1',
      [
        { title: 'A', description: 'A desc', details: '', testStrategy: '' },
        { title: 'B', description: 'B desc', details: '', testStrategy: '' },
        { title: 'C', description: 'C desc', details: '', testStrategy: '' },
      ],
      { projectRoot: TEST_ROOT, force: true, strategy: 'parallel' }
    );

    after = JSON.parse(await readFile(tasksPath, 'utf-8'));
    subs = after.tasks[0].subtasks;
    expect(subs.length).toBe(3);
    expect(subs[0].dependencies).toEqual([]);
    expect(subs[1].dependencies).toEqual([]);
    expect(subs[2].dependencies).toEqual([]);
  });

  it('应能为 task/subtask 追加 dependencies（去重）', async () => {
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });

    const t1: Task = makeTask({
      id: '1',
      title: 'T1',
      description: 'D1',
      status: 'pending',
      subtasks: [
        {
          id: 1,
          parentId: '1',
          title: 'S1',
          description: 'S1 desc',
          status: 'pending',
          priority: 'medium',
          dependencies: [],
          details: '',
          testStrategy: '',
        },
        {
          id: 2,
          parentId: '1',
          title: 'S2',
          description: 'S2 desc',
          status: 'pending',
          priority: 'medium',
          dependencies: [],
          details: '',
          testStrategy: '',
        },
      ],
    });
    const t2: Task = makeTask({
      id: '2',
      title: 'T2',
      description: 'D2',
      status: 'pending',
      dependencies: [],
      subtasks: [],
    });

    await writeFile(
      tasksPath,
      JSON.stringify(
        {
          tasks: [t1, t2],
          metadata: { ...makeMetadata(), taskCount: 2 },
        },
        null,
        2
      ),
      'utf-8'
    );

    await addTaskOrSubtaskDependency('2', '1', { projectRoot: TEST_ROOT });
    await addTaskOrSubtaskDependency('2', '1', { projectRoot: TEST_ROOT }); // 去重
    await addTaskOrSubtaskDependency('1.2', '1.1', { projectRoot: TEST_ROOT });

    const after = JSON.parse(await readFile(tasksPath, 'utf-8'));
    const task2 = after.tasks.find((t: any) => String(t.id) === '2');
    expect(task2.dependencies).toEqual(['1']);

    const task1 = after.tasks.find((t: any) => String(t.id) === '1');
    const s2 = task1.subtasks.find((s: any) => String(s.id) === '2');
    expect(s2.dependencies).toEqual(['1.1']);
  });
});


