import { githubActionsHeaders, githubActionsRequest, repositoryPath } from '../../providers/github/actions-client.ts';
import { resolveWorkflowRunAuthority } from '../../providers/github/workflow-authority.ts';
import { parse as parseYaml } from 'yaml';

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const parse = (value: unknown, fallback: unknown) => {
	try { return JSON.parse(String(value ?? JSON.stringify(fallback))); } catch { return fallback; }
};

function refPath(ref: string) {
	const normalized = ref.replace(/^refs\//u, '');
	if (!/^(heads|tags)\/[A-Za-z0-9._/-]+$/u.test(normalized) || normalized.includes('..')) throw new Error('The workflow ref is invalid.');
	return normalized.split('/').map(encodeURIComponent).join('/');
}

function requirementPath(owner: string, repository: string, repositoryId: string, requirement: any, kind: 'secrets' | 'variables') {
	const name = encodeURIComponent(String(requirement.name));
	if (requirement.scope === 'repository') return `${repositoryPath(owner, repository)}/actions/${kind}/${name}`;
	if (requirement.scope === 'environment' && requirement.environment) return `/repositories/${encodeURIComponent(repositoryId)}/environments/${encodeURIComponent(requirement.environment)}/${kind}/${name}`;
	if (requirement.scope === 'organization') return `/orgs/${encodeURIComponent(owner)}/actions/${kind}/${name}`;
	throw new Error(`Invalid ${kind} requirement scope.`);
}

async function present(fetchImpl: typeof fetch, token: string, path: string) {
	const response = await fetchImpl(`https://api.github.com${path}`, { headers: githubActionsHeaders(token) });
	if (response.status === 404) return false;
	if (!response.ok) throw new Error(`GitHub configuration readiness check failed (HTTP ${response.status}).`);
	return true;
}

export function assertWorkflowContract(source: string) {
	let workflow: any;
	try { workflow = parseYaml(source); } catch { throw new Error('The workflow YAML is invalid.'); }
	if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error('The workflow YAML must be a mapping.');
	const dispatch = workflow.on?.workflow_dispatch;
	if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) throw new Error('The workflow does not declare workflow_dispatch.');
	const correlation = dispatch.inputs?.treeseed_operation_correlation;
	if (!correlation || typeof correlation !== 'object' || correlation.required !== true) {
		throw new Error('The workflow must require the TreeSeed operation correlation input.');
	}
	const runName = typeof workflow['run-name'] === 'string' ? workflow['run-name'] : '';
	if (!/(?:inputs|github\.event\.inputs)\.treeseed_operation_correlation/u.test(runName)) {
		throw new Error('The workflow run-name must include the TreeSeed operation correlation input.');
	}
}

async function identifyRun(fetchImpl: typeof fetch, token: string, owner: string, repository: string, workflowId: string, sourceSha: string, correlationId: string) {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const payload: any = await githubActionsRequest(fetchImpl, token, `${repositoryPath(owner, repository)}/actions/workflows/${encodeURIComponent(workflowId)}/runs?event=workflow_dispatch&head_sha=${encodeURIComponent(sourceSha)}&per_page=50`);
		const match = (payload?.workflow_runs ?? []).find((run: any) =>
			String(run.display_title ?? run.name ?? '').includes(correlationId)
			&& String(run.event ?? '') === 'workflow_dispatch' && String(run.head_sha ?? '') === sourceSha
			&& String(run.path ?? '').split('@', 1)[0] === workflowId);
		if (match) return match;
		await pause(1_500);
	}
	throw new Error('GitHub accepted the dispatch but no exactly correlated workflow run appeared.');
}

export function createGitHubWorkflowExecutor(options: { controlPlaneStore: any; fetchImpl?: typeof fetch }) {
	return {
		namespace: 'workflow', operation: 'dispatch',
		async run(input: any, context: any) {
			const store = options.controlPlaneStore;
			if (!store) throw new Error('Workflow execution requires the control-plane store.');
			const run = await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [input?.runId]);
			if (!run || run.correlation_id !== context.operation.id) throw new Error('The workflow operation run correlation is invalid.');
			if (run.status !== 'authorizing') return { runId: run.id, status: run.status, providerRunId: run.provider_run_id };
			const fetchImpl = options.fetchImpl ?? fetch;
			try {
				const provider = await resolveWorkflowRunAuthority({ store, run, fetchImpl });
				const { definition, repository: binding, credential } = provider;
				const owner = String(binding.owner); const repository = String(binding.name); const workflowId = String(definition.workflow_id);
				const remoteRef: any = await githubActionsRequest(fetchImpl, credential.token, `${repositoryPath(owner, repository)}/git/ref/${refPath(run.ref)}`);
				if (remoteRef?.object?.sha !== run.source_sha) throw new Error('The authorized workflow ref no longer resolves to the reviewed source SHA.');
				const content: any = await githubActionsRequest(fetchImpl, credential.token, `${repositoryPath(owner, repository)}/contents/${workflowId.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(run.source_sha)}`);
				assertWorkflowContract(Buffer.from(String(content?.content ?? ''), 'base64').toString('utf8'));
				for (const requirement of parse(definition.required_secrets_json, []) as any[]) {
					if (requirement.required && !await present(fetchImpl, credential.token, requirementPath(owner, repository, String(binding.provider_repository_id), requirement, 'secrets'))) throw new Error(`Required workflow secret ${requirement.name} is not configured.`);
				}
				for (const requirement of parse(definition.required_variables_json, []) as any[]) {
					if (requirement.required && !await present(fetchImpl, credential.token, requirementPath(owner, repository, String(binding.provider_repository_id), requirement, 'variables'))) throw new Error(`Required workflow variable ${requirement.name} is not configured.`);
				}
				const inputs = { ...(input.inputs ?? {}), treeseed_operation_correlation: run.correlation_id };
				await context.checkpoint({ phase: 'workflow.authorized', runId: run.id, sourceSha: run.source_sha }, { kind: 'workflow.authorized', data: { runId: run.id, operationId: run.operation_id, sourceSha: run.source_sha } });
				await githubActionsRequest(fetchImpl, credential.token, `${repositoryPath(owner, repository)}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: run.ref, inputs }) });
				const providerRun = await identifyRun(fetchImpl, credential.token, owner, repository, workflowId, run.source_sha, run.correlation_id);
				const now = new Date().toISOString();
				await store.run(`UPDATE workflow_operation_runs SET provider_run_id = ?, provider_run_url = ?, status = ?, updated_at = ? WHERE id = ? AND status = 'authorizing'`,
					[String(providerRun.id), providerRun.html_url ?? null, providerRun.status === 'queued' ? 'queued' : 'running', now, run.id]);
				await store.recordAuditEvent({ eventType: 'workflow.dispatched', actorType: 'service', actorId: context.operation.assignedRunnerId ?? 'operations-runner', targetType: 'workflow_operation_run', targetId: run.id,
					data: { operationId: run.operation_id, projectId: run.project_id, teamId: run.team_id, providerRunId: String(providerRun.id), sourceSha: run.source_sha, correlationId: run.correlation_id } });
				return { runId: run.id, status: providerRun.status, providerRunId: String(providerRun.id), providerRunUrl: providerRun.html_url ?? null };
			} catch (error) {
				await store.run(`UPDATE workflow_operation_runs SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'authorizing'`, [new Date().toISOString(), run.id]);
				throw error;
			}
		},
	};
}
