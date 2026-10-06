import { describe, expect, it, vi } from 'vitest';
import { listCapacityWorkdayContentArtifactRefs } from '../../../../../../src/api/capacity/services/capacity/workdays/assignments/workday-assignment-context-service.ts';

describe('workday assignment context custody', () => {
  it('reads completed artifacts from assignments owned by the workday, without a demand join', async () => {
    const all = vi.fn(async () => []);
    const refs = await listCapacityWorkdayContentArtifactRefs(
      { all } as never,
      { id: 'run-1', teamId: 'team-1' } as never,
      'project-1',
    );
    expect(refs).toEqual([]);
    expect(all).toHaveBeenCalledOnce();
    const [sql, params] = all.mock.calls[0]!;
    expect(sql).toContain('assignment.work_day_id = ?');
    expect(sql).not.toContain('capacity_workday_demands');
    expect(params).toEqual(['team-1', 'project-1', 'run-1', 200]);
  });
});
