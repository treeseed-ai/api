import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextQueryCheckService } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';

describe('scheduled context-check renewal',()=>{
  afterEach(()=>vi.restoreAllMocks());
  const commit='a'.repeat(40);
  function fixture(paths=['agent-tests/nested/general.md','agent-tests/chat.mdx']) {
    const rows=['general-test','chat-test'].map((test_id,index)=>({id:`expired-${index}`,team_id:'team',project_id:'sdk',test_id}));
    const service=new ContextQueryCheckService({all:vi.fn().mockResolvedValue(rows)} as unknown as CapacityGovernanceDatabase);
    vi.spyOn(service,'definitionCommit').mockResolvedValue(commit);
    const catalog=vi.spyOn(service,'catalog').mockResolvedValue({commit,tests:paths.map((path,index)=>({id:rows[index]?.test_id??'general-test',path}))} as unknown as Awaited<ReturnType<ContextQueryCheckService['catalog']>>);
    const check=vi.spyOn(service,'check').mockResolvedValue({status:'passing'} as Awaited<ReturnType<ContextQueryCheckService['check']>>);
    return {service,catalog,check};
  }
  it('uses actual nested/extension-aware test paths, frozen commits and one catalog per project',async()=>{
    const {service,catalog,check}=fixture();
    expect(await service.recheckDue()).toMatchObject({considered:2,passing:2,failures:[]});
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(check.mock.calls.map(call=>call[2])).toEqual([
      {testId:'general-test',testPath:'agent-tests/nested/general.md',definitionRef:commit,idempotencyKey:'scheduled-context-query-check:expired-0'},
      {testId:'chat-test',testPath:'agent-tests/chat.mdx',definitionRef:commit,idempotencyKey:'scheduled-context-query-check:expired-1'},
    ]);
  });
  it('does not guess missing test filenames',async()=>{
    const {service,check}=fixture([]);
    const result=await service.recheckDue();
    expect(result.failures).toHaveLength(2);
    expect(check).not.toHaveBeenCalled();
  });
  it('fails closed for ambiguous test IDs',async()=>{
    const {service,catalog,check}=fixture();
    catalog.mockResolvedValue({commit,tests:[{id:'general-test',path:'agent-tests/a.md'},{id:'general-test',path:'agent-tests/b.md'}]} as unknown as Awaited<ReturnType<ContextQueryCheckService['catalog']>>);
    expect((await service.recheckDue()).failures).toHaveLength(2);
    expect(check).not.toHaveBeenCalled();
  });
  it('retains failed assertion outcomes rather than manufacturing passing evidence',async()=>{
    const {service,check}=fixture();
    check.mockResolvedValue({status:'failing'} as Awaited<ReturnType<ContextQueryCheckService['check']>>);
    expect(await service.recheckDue()).toMatchObject({passing:0,failing:2});
  });
});
