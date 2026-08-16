import { describe,expect,it,vi } from 'vitest';
import { ensureTreeDxContextGraphReady } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-context-readiness.ts';

describe('dynamic TreeDX context graph readiness',()=>{
	it('refreshes only requested paths at the exact live ref and waits for completion',async()=>{
		const request=vi.fn()
			.mockResolvedValueOnce({jobId:'job-1',ready:true})
			.mockResolvedValueOnce({job:{status:'completed',jobId:'job-1'}});
		await ensureTreeDxContextGraphReady({
			repoId:'repo-a',
			body:{ref:'a'.repeat(40),scopePaths:['/src/content/knowledge/work.md']},
			request,
		});
		expect(request).toHaveBeenNthCalledWith(1,'POST','/api/v1/repos/repo-a/graph/refresh',{
			ref:'a'.repeat(40),
			paths:['src/content/knowledge/work.md'],
			changedPaths:['src/content/knowledge/work.md'],
			incremental:true,
			allowProtected:false,
		});
		expect(request).toHaveBeenNthCalledWith(2,'GET',`/api/v1/repos/repo-a/graph/refresh-jobs/job-1?ref=${'a'.repeat(40)}`);
	});

	it('rejects context execution without an explicit ref',async()=>{
		await expect(ensureTreeDxContextGraphReady({repoId:'repo-a',body:{},request:vi.fn()}))
			.rejects.toMatchObject({code:'treedx_context_exact_ref_required'});
	});
});
