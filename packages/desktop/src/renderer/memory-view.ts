export type MemoryLifecycle = 'active' | 'superseded' | 'inactive';

export interface MemoryRecordView {
  id: string;
  type: string;
  content: string;
  tags?: string[];
  createdAt?: string;
  lifecycle?: MemoryLifecycle;
  score?: number;
}

export interface MemoryViewGroup {
  type: string;
  records: MemoryRecordView[];
}

export interface MemoryView {
  userGroups: MemoryViewGroup[];
  experiences: MemoryRecordView[];
  expandExperiences: boolean;
  userMemoryEmpty: boolean;
}

function newestFirst(left: MemoryRecordView, right: MemoryRecordView): number {
  return (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
}

export function buildMemoryView(
  records: readonly MemoryRecordView[],
  searchActive: boolean
): MemoryView {
  const experiences = records.filter((record) => record.type === 'experience').sort(newestFirst);
  const grouped = new Map<string, MemoryRecordView[]>();
  for (const record of records) {
    if (record.type === 'experience') continue;
    const group = grouped.get(record.type) ?? [];
    group.push(record);
    grouped.set(record.type, group);
  }
  const userGroups = Array.from(grouped, ([type, groupRecords]) => ({
    type,
    records: groupRecords.sort(newestFirst),
  }));
  return {
    userGroups,
    experiences,
    expandExperiences: searchActive && experiences.length > 0,
    userMemoryEmpty: userGroups.length === 0,
  };
}

const FEEDBACK_LIFECYCLE_LABELS: Record<MemoryLifecycle, string> = {
  active: '生效中',
  superseded: '已替代',
  inactive: '已停用',
};

export function feedbackLifecycleLabel(lifecycle: MemoryLifecycle | undefined): string | undefined {
  return lifecycle ? FEEDBACK_LIFECYCLE_LABELS[lifecycle] : undefined;
}

export function systemRecordsSummary(count: number): string {
  return `系统记录 · ${count}`;
}
