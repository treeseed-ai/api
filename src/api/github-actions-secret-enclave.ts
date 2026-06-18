import {
	assertTreeseedGitHubActionsEncryptedSecretDeployment,
	containsTreeseedPlaintextSecretMaterial,
	validateTreeseedSecretsCapabilityRegistry,
} from '@treeseed/sdk/secrets-capability';
import { reconcileTreeseedTarget, type TreeseedDesiredUnit } from '@treeseed/sdk/reconcile';
import { Octokit } from 'octokit';
import { createGitHubAppAdapter } from './github-app-adapter.ts';

function failClosedError(code: string, message: string, status = 403) {
	const error = new Error(message);
	(error as any).status = status;
	(error as any).code = code;
	return error;
}

function normalizeRepository(value: unknown): string {
	return String(value ?? '').trim().replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, '').toLowerCase();
}

function parseRepository(repository: string) {
	const [owner, repo, ...rest] = normalizeRepository(repository).split('/');
	if (!owner || !repo || rest.length > 0) {
		throw failClosedError('github_repository_removed', 'GitHub repository must be in owner/name form.', 400);
	}
	return { owner, repo, repository: `${owner}/${repo}` };
}

function objectValue(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [];
}

function trustPolicyFor(operation: any) {
	const metadata = objectValue(operation?.metadata);
	return objectValue(operation?.trustPolicy ?? metadata.trustPolicy);
}

function inputSchemaFor(operation: any) {
	return Array.isArray(operation?.inputs) ? operation.inputs : [];
}

function validateWorkflowInputs(operation: any, inputs: Record<string, unknown>) {
	for (const schema of inputSchemaFor(operation)) {
		const name = typeof schema?.name === 'string' ? schema.name : null;
		if (!name) continue;
		const value = inputs[name];
		if (schema.required === true && (value == null || String(value).trim() === '')) {
			throw failClosedError('workflow_dispatch_blocked', `Workflow operation input "${name}" is required.`, 400);
		}
		if (Array.isArray(schema.allowedValues) && schema.allowedValues.length > 0 && value != null && !schema.allowedValues.includes(String(value))) {
			throw failClosedError('workflow_dispatch_blocked', `Workflow operation input "${name}" is not allowlisted.`, 400);
		}
	}
}

function workflowDispatchUnit(input: {
	repository: string;
	workflow: string;
	branch: string;
	inputs: Record<string, string>;
	wait: boolean;
	timeoutMs?: number | null;
	expectedHeadSha?: string | null;
}) {
	const unit: TreeseedDesiredUnit = {
		unitId: `github-workflow-dispatch:${input.repository}:${input.branch}:${input.workflow}`.replace(/[^A-Za-z0-9:._/-]+/gu, '-'),
		unitType: 'github-workflow-dispatch',
		provider: 'github',
		identity: {
			project: 'treeseed',
			environment: 'staging',
			resource: 'github-workflow-dispatch',
			name: `${input.repository}:${input.workflow}`,
		},
		target: { kind: 'persistent', scope: 'staging' },
		logicalName: `${input.repository} ${input.workflow} @ ${input.branch}`,
		dependencies: [],
		spec: {
			repository: input.repository,
			workflow: input.workflow,
			branch: input.branch,
			inputs: input.inputs,
			wait: input.wait,
			...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
			...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}),
		},
		secrets: {},
		metadata: {
			resourceKind: 'github-workflow-dispatch',
			repository: input.repository,
			workflow: input.workflow,
			branch: input.branch,
		},
	};
	return unit;
}

export function createGitHubActionsSecretEnclave(options: {
	store: any;
	config?: Record<string, any>;
	githubAppAdapter?: any;
	githubClientFactory?: (input: { token: string; installationId: string; repository: string }) => any;
	workflowDispatcher?: (input: { token: string; unit: TreeseedDesiredUnit; operation: any; dispatchRecord: any }) => Promise<any>;
	now?: () => Date;
}) {
	const store = options.store;
	const now = options.now ?? (() => new Date());
	const githubAppAdapter = options.githubAppAdapter ?? createGitHubAppAdapter({ store, config: options.config ?? {} });

	function githubClient(input: { token: string; installationId: string; repository: string }) {
		return options.githubClientFactory?.(input) ?? new Octokit({ auth: input.token });
	}

	async function mintToken(input: any, requiredPermissions: Record<string, string>, allowedOperations: string[]) {
		return githubAppAdapter.mintInstallationToken({
			...input,
			requiredPermissions,
			allowedOperations,
			policy: {
				...(input.policy ?? {}),
				allowedRefs: input.allowedRefs,
				requireAssignment: input.requireAssignment === true,
				requireProvider: input.requireProvider === true,
				requireWorkday: input.requireWorkday === true,
			},
		});
	}

	async function fetchPublicKey(input: any) {
		const repository = normalizeRepository(input.repository);
		const { owner, repo } = parseRepository(repository);
		const scope = String(input.scope ?? 'environment');
		const environment = typeof input.environment === 'string' ? input.environment.trim() : null;
		if (scope === 'environment' && !environment) {
			throw failClosedError('github_environment_missing', 'GitHub environment public key requests require an environment.', 400);
		}
		const authority = await mintToken({
			...input,
			repository,
			operationId: input.operationId ?? 'github-actions-secret-public-key',
		}, { metadata: 'read', secrets: 'write', environments: scope === 'environment' ? 'read' : undefined }, ['github-actions-secret-public-key']);
		const client = githubClient({ token: authority.token, installationId: String(input.installationId), repository });
		const response = scope === 'environment'
			? await client.request('GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key', {
				owner,
				repo,
				environment_name: environment,
			})
			: await client.request('GET /repos/{owner}/{repo}/actions/secrets/public-key', { owner, repo });
		const data = response?.data ?? response;
		const publicKey = {
			repository,
			scope,
			environment,
			keyId: String(data?.key_id ?? ''),
			key: String(data?.key ?? ''),
			observedAt: now().toISOString(),
		};
		if (!publicKey.keyId || !publicKey.key) {
			throw failClosedError('github_environment_missing', 'GitHub did not return a usable Actions secret public key.', 502);
		}
		await store.recordSecretCapabilityAudit('github_actions_secret_public_key.observed', {
			teamId: input.teamId,
			projectId: input.projectId ?? null,
			repository,
			status: 'observed',
			metadata: { scope, environment, keyId: publicKey.keyId },
		});
		return publicKey;
	}

	async function deployEncryptedSecret(input: any) {
		if (containsTreeseedPlaintextSecretMaterial(input)) {
			throw failClosedError('plaintext_escrow_material', 'GitHub Actions secret deployment payloads must not include plaintext secret material.', 400);
		}
		const deployment = assertTreeseedGitHubActionsEncryptedSecretDeployment(input);
		const repository = normalizeRepository(deployment.repository);
		const { owner, repo } = parseRepository(repository);
		const scope = deployment.scope;
		const environment = deployment.environment ?? null;
		const authority = await mintToken({
			...input,
			repository,
			operationId: input.operationId ?? 'github-actions-secret-deploy',
		}, { metadata: 'read', secrets: 'write', environments: scope === 'environment' ? 'write' : undefined }, ['github-actions-secret-deploy']);
		const client = githubClient({ token: authority.token, installationId: String(input.installationId), repository });
		if (scope === 'environment') {
			await client.request('PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}', {
				owner,
				repo,
				environment_name: environment,
				secret_name: deployment.secretName,
				encrypted_value: deployment.encryptedValue,
				key_id: deployment.keyId,
			});
		} else {
			await client.request('PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
				owner,
				repo,
				secret_name: deployment.secretName,
				encrypted_value: deployment.encryptedValue,
				key_id: deployment.keyId,
			});
		}
		const secret = await store.createSecretMetadataRecord({
			id: deployment.secretId ?? input.secretId ?? undefined,
			teamId: input.teamId,
			projectId: input.projectId ?? null,
			name: deployment.secretName,
			secretClass: input.secretClass ?? 'customer_project_secret',
			custodyMode: 'github_actions_secret_enclave',
			owner: { kind: 'customer', teamId: input.teamId, projectId: input.projectId ?? null },
			githubSecretTarget: {
				repository,
				environment,
				secretName: deployment.secretName,
				scope,
			},
			metadata: {
				...(deployment.metadata ?? {}),
				keyId: deployment.keyId,
				deployedAt: now().toISOString(),
			},
		});
		await store.recordSecretCapabilityAudit('github_actions_secret.deployed', secret);
		return { secret };
	}

	async function defaultWorkflowDispatcher(input: { token: string; unit: TreeseedDesiredUnit }) {
		return reconcileTreeseedTarget({
			tenantRoot: String(options.config?.repoRoot ?? process.cwd()),
			target: { kind: 'persistent', scope: 'staging' },
			env: {
				...process.env,
				GH_TOKEN: input.token,
			},
			units: [input.unit],
			dryRun: false,
		});
	}

	async function dispatchWorkflowOperation(input: any) {
		if (containsTreeseedPlaintextSecretMaterial(input)) {
			throw failClosedError('plaintext_escrow_material', 'Workflow operation dispatch payloads must not include plaintext secret material.', 400);
		}
		const operation = await store.getWorkflowOperationRecord(input.operationId);
		if (!operation) throw failClosedError('workflow_dispatch_blocked', 'Unknown workflow operation.', 404);
		if (operation.status !== 'active') throw failClosedError(operation.failClosedCode ?? 'workflow_dispatch_blocked', 'Workflow operation is not active.');
		if (operation.providerSuppliedCommandsAllowed === true) throw failClosedError('arbitrary_secret_workflow_dispatch', 'Provider-supplied commands are not allowed for secret-bearing workflow operations.');
		const dispatch = objectValue(operation.dispatch);
		if (operation.secretBearing === true && (dispatch.mode !== 'allowlisted' || dispatch.arbitraryDispatch === true)) {
			throw failClosedError('arbitrary_secret_workflow_dispatch', 'Secret-bearing workflow operations must use allowlisted dispatch.');
		}
		const trustPolicy = trustPolicyFor(operation);
		const protectedRefs = stringArray(trustPolicy.protectedRefs);
		const allowedWorkflowFiles = stringArray(trustPolicy.allowedWorkflowFiles);
		const protectedEnvironments = stringArray(trustPolicy.protectedEnvironments);
		const ref = String(input.ref ?? protectedRefs[0] ?? '').trim();
		const environment = typeof input.environment === 'string' ? input.environment.trim() : null;
		if (operation.secretBearing === true) {
			const validation = validateTreeseedSecretsCapabilityRegistry({
				repositoryCredentialProviders: { githubApp: { type: 'github-app' } },
				workflowOperations: { operations: [operation] },
			});
			if (!validation.ok) throw failClosedError(validation.problems[0]?.code ?? 'workflow_dispatch_blocked', validation.problems[0]?.message ?? 'Workflow operation trust policy is invalid.', 400);
			if (!protectedRefs.includes(ref)) throw failClosedError('workflow_trust_drift', 'Workflow operation ref is not protected or allowlisted.');
			if (!allowedWorkflowFiles.includes(operation.workflowFile)) throw failClosedError('workflow_trust_drift', 'Workflow operation file is not allowlisted.');
			if (protectedEnvironments.length > 0 && (!environment || !protectedEnvironments.includes(environment))) {
				throw failClosedError('github_environment_missing', 'Secret-bearing workflow operation requires a protected GitHub environment.');
			}
		}
		const inputs = objectValue(input.inputs);
		validateWorkflowInputs(operation, inputs);
		const dispatchRecord = await store.createWorkflowDispatchRecord({
			teamId: input.teamId,
			projectId: input.projectId ?? operation.projectId ?? null,
			workflowOperationId: operation.id,
			platformOperationId: input.platformOperationId ?? null,
			repository: operation.repository,
			workflowFile: operation.workflowFile,
			ref,
			status: 'queued',
			inputs,
			metadata: { environment },
		});
		const authority = await mintToken({
			...input,
			repository: operation.repository,
			operationId: operation.id,
			ref,
			allowedRefs: protectedRefs,
		}, { metadata: 'read', contents: 'read', actions: 'write' }, ['github-actions-workflow-dispatch']);
		const unit = workflowDispatchUnit({
			repository: operation.repository,
			workflow: operation.workflowFile,
			branch: ref.replace(/^refs\/heads\//u, ''),
			inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, String(value ?? '')])),
			wait: input.wait === true,
			timeoutMs: typeof trustPolicy.timeoutSeconds === 'number' ? trustPolicy.timeoutSeconds * 1000 : null,
			expectedHeadSha: typeof input.expectedHeadSha === 'string' ? input.expectedHeadSha : null,
		});
		const result = await (options.workflowDispatcher ?? defaultWorkflowDispatcher)({
			token: authority.token,
			unit,
			operation,
			dispatchRecord,
		});
		const updated = await store.updateWorkflowDispatchRecord(dispatchRecord.id, {
			status: result?.ok === false ? 'failed' : input.wait === true ? 'succeeded' : 'dispatched',
			result,
			dispatchedAt: now().toISOString(),
			completedAt: input.wait === true ? now().toISOString() : null,
			failClosedCode: result?.ok === false ? 'workflow_dispatch_blocked' : null,
			metadata: { environment, reconcileUnitId: unit.unitId },
		});
		return { dispatch: updated, reconcile: result };
	}

	return {
		fetchPublicKey,
		deployEncryptedSecret,
		dispatchWorkflowOperation,
	};
}
