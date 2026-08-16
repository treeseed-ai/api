import { CapacityGovernanceError } from '../../../database.ts';

type TreeDxRequest = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String).map((item) => item.trim().replace(/^\/+/, '')).filter(Boolean) : [];
}

export async function ensureTreeDxContextGraphReady(input: {
	repoId: string;
	body: Record<string, unknown>;
	request: TreeDxRequest;
}) {
	const ref = typeof input.body.ref === 'string' ? input.body.ref.trim() : '';
	if (!ref) throw new CapacityGovernanceError(
		'treedx_context_exact_ref_required',
		'Dynamic TreeDX context requires an exact repository ref.',
		400,
	);
	const paths = strings(input.body.scopePaths).length
		? strings(input.body.scopePaths)
		: strings(input.body.paths).length ? strings(input.body.paths) : ['**'];
	const repo = encodeURIComponent(input.repoId);
	const refresh = record(await input.request('POST', `/api/v1/repos/${repo}/graph/refresh`, {
		ref,
		paths,
		changedPaths: paths,
		incremental: true,
		allowProtected: input.body.allowProtected === true,
	}));
	const jobId = typeof refresh.jobId === 'string' ? refresh.jobId.trim() : '';
	if (!jobId) {
		if (refresh.ready === true) return refresh;
		throw new CapacityGovernanceError('treedx_context_graph_refresh_invalid', 'TreeDX did not return context graph readiness evidence.', 502);
	}
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const jobResponse = record(await input.request('GET', `/api/v1/repos/${repo}/graph/refresh-jobs/${encodeURIComponent(jobId)}?ref=${encodeURIComponent(ref)}`));
		const job = record(jobResponse.job ?? jobResponse);
		if (job.status === 'completed') return { ...refresh, job };
		if (job.status === 'failed') throw new CapacityGovernanceError(
			'treedx_context_graph_refresh_failed',
			'TreeDX failed to refresh the exact dynamic-context graph.',
			409,
			{ ref, jobId, errorCode: job.errorCode ?? null },
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new CapacityGovernanceError(
		'treedx_context_graph_refresh_timeout',
		'TreeDX did not prepare the exact dynamic-context graph before the bounded deadline.',
		504,
		{ ref, jobId },
	);
}
