import { githubActionsHeaders, githubActionsRequest, repositoryPath } from './actions-client.ts';

export const MAX_WORKFLOW_ARTIFACT_BYTES = 50 * 1024 * 1024;

export class WorkflowArtifactError extends Error {
	constructor(message: string, readonly status: number, readonly code: string) {
		super(message);
	}
}

function numericId(value: unknown, label: string) {
	const id = String(value ?? '');
	if (!/^\d+$/u.test(id)) throw new WorkflowArtifactError(`${label} is invalid.`, 422, 'workflow_artifact_invalid');
	return id;
}

function archiveName(value: unknown, artifactId: string) {
	const normalized = String(value ?? '').normalize('NFKC').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 100);
	return `${normalized || `workflow-artifact-${artifactId}`}.zip`;
}

async function boundedBytes(response: Response) {
	const declared = Number(response.headers.get('content-length') ?? 0);
	if (declared > MAX_WORKFLOW_ARTIFACT_BYTES) {
		throw new WorkflowArtifactError('The workflow artifact exceeds the download limit.', 413, 'workflow_artifact_too_large');
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_WORKFLOW_ARTIFACT_BYTES) {
				throw new WorkflowArtifactError('The workflow artifact exceeds the download limit.', 413, 'workflow_artifact_too_large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return bytes;
}

export async function fetchWorkflowArtifactArchive(input: {
	fetchImpl: typeof fetch; token: string; owner: string; repository: string; runId: unknown; artifactId: unknown;
}) {
	const runId = numericId(input.runId, 'Workflow run identifier');
	const artifactId = numericId(input.artifactId, 'Workflow artifact identifier');
	const repository = repositoryPath(input.owner, input.repository);
	const listing: any = await githubActionsRequest(input.fetchImpl, input.token,
		`${repository}/actions/runs/${encodeURIComponent(runId)}/artifacts?per_page=100`);
	const artifact = (Array.isArray(listing?.artifacts) ? listing.artifacts : [])
		.find((candidate: any) => String(candidate?.id ?? '') === artifactId);
	if (!artifact) throw new WorkflowArtifactError('Workflow artifact not found for this run.', 404, 'workflow_artifact_not_found');
	if (artifact.expired) throw new WorkflowArtifactError('The workflow artifact has expired.', 410, 'workflow_artifact_expired');
	const response = await input.fetchImpl(`https://api.github.com${repository}/actions/artifacts/${encodeURIComponent(artifactId)}/zip`, {
		headers: githubActionsHeaders(input.token), redirect: 'follow',
	});
	if (!response.ok) throw new WorkflowArtifactError(`Workflow artifact download failed (HTTP ${response.status}).`, 503, 'workflow_artifact_unavailable');
	const bytes = await boundedBytes(response);
	if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
		throw new WorkflowArtifactError('The provider returned an invalid workflow artifact archive.', 502, 'workflow_artifact_invalid_archive');
	}
	return { bytes, fileName: archiveName(artifact.name, artifactId), sizeBytes: bytes.byteLength };
}
