import { describe, expect, it, vi } from 'vitest';
import { fetchWorkflowArtifactArchive, MAX_WORKFLOW_ARTIFACT_BYTES } from '../../../../src/providers/github/workflow-artifacts.ts';
import { reconciledWorkflowRunStatus } from '../../../../src/providers/github/actions-client.ts';

function response(body: BodyInit | null, init: ResponseInit = {}) {
	return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init }));
}

describe('workflow artifact archives', () => {
	it('preserves a pending cancellation until the provider reaches a terminal state', () => {
		expect(reconciledWorkflowRunStatus('cancelling', 'in_progress')).toBe('cancelling');
		expect(reconciledWorkflowRunStatus('cancelling', 'completed', 'cancelled')).toBe('cancelled');
		expect(reconciledWorkflowRunStatus('running', 'completed', 'success')).toBe('completed');
	});
	it('downloads only an artifact owned by the exact correlated run', async () => {
		const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);
		const fetchImpl = vi.fn()
			.mockImplementationOnce(() => response(JSON.stringify({ artifacts: [{ id: 42, name: 'test output', expired: false }] })))
			.mockImplementationOnce(() => response(zip, { headers: { 'content-type': 'application/zip', 'content-length': String(zip.byteLength) } }));
		const archive = await fetchWorkflowArtifactArchive({ fetchImpl, token: 'canary-token', owner: 'owner', repository: 'repo', runId: '7', artifactId: '42' });
		expect(archive.fileName).toBe('test-output.zip');
		expect([...archive.bytes]).toEqual([...zip]);
		expect(fetchImpl.mock.calls[0][0]).toContain('/actions/runs/7/artifacts');
		expect(fetchImpl.mock.calls[1][0]).toContain('/actions/artifacts/42/zip');
	});

	it('rejects artifacts from another run without requesting their archive', async () => {
		const fetchImpl = vi.fn().mockImplementationOnce(() => response(JSON.stringify({ artifacts: [{ id: 41, name: 'other' }] })));
		await expect(fetchWorkflowArtifactArchive({ fetchImpl, token: 'token', owner: 'owner', repository: 'repo', runId: '7', artifactId: '42' }))
			.rejects.toMatchObject({ status: 404, code: 'workflow_artifact_not_found' });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('fails before buffering a declared oversized archive', async () => {
		const fetchImpl = vi.fn()
			.mockImplementationOnce(() => response(JSON.stringify({ artifacts: [{ id: 42, name: 'large', expired: false }] })))
			.mockImplementationOnce(() => response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { headers: { 'content-length': String(MAX_WORKFLOW_ARTIFACT_BYTES + 1) } }));
		await expect(fetchWorkflowArtifactArchive({ fetchImpl, token: 'token', owner: 'owner', repository: 'repo', runId: '7', artifactId: '42' }))
			.rejects.toMatchObject({ status: 413, code: 'workflow_artifact_too_large' });
	});

	it('rejects non-ZIP provider responses', async () => {
		const fetchImpl = vi.fn()
			.mockImplementationOnce(() => response(JSON.stringify({ artifacts: [{ id: 42, name: 'bad', expired: false }] })))
			.mockImplementationOnce(() => response('not a zip'));
		await expect(fetchWorkflowArtifactArchive({ fetchImpl, token: 'token', owner: 'owner', repository: 'repo', runId: '7', artifactId: '42' }))
			.rejects.toMatchObject({ status: 502, code: 'workflow_artifact_invalid_archive' });
	});
});
