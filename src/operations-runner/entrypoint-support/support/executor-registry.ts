import { createFeedbackRetentionExecutor } from '../../feedback/retention-executor.ts';
import { createKnowledgePublicationExecutor } from '../../knowledge/publication-executor.ts';
import { createKnowledgePackCleanupExecutor, createKnowledgePackExecutor } from '../../knowledge/pack-executor.ts';
import { createGitHubWorkflowExecutor } from '../../workflows/github-workflow-executor.ts';
import { createGitHubConfigurationExecutor } from '../../workflows/github-configuration-executor.ts';
import { createTreeDxCommitReplicationExecutor } from '../../treedx/commit-replication-executor.ts';
import { createTreeDxRemoteHeadReconciliationExecutor } from '../../treedx/remote-head-reconciliation-executor.ts';
import { createHostedTopologyExecutors } from '../../infrastructure/hosted-topology-executor.ts';
import { createHostedProviderAdapter } from '../../infrastructure/hosted-provider-adapter.ts';

export function createExecutors() {
	return createExecutorsForOptions({});
}

export function createExecutorsForOptions(options: any = {}) {
	const hostedTopologyAdapter = options.hostedTopologyAdapter ?? (options.controlPlaneStore
		? createHostedProviderAdapter({ store: options.controlPlaneStore, fetchImpl: options.fetchImpl, env: options.env, externalAuthorityResolver: options.externalAuthorityResolver })
		: undefined);
	const workflowExecutor = createGitHubWorkflowExecutor({ controlPlaneStore: options.controlPlaneStore, fetchImpl: options.fetchImpl });
	const workflowConfigurationExecutor = createGitHubConfigurationExecutor({ controlPlaneStore: options.controlPlaneStore, fetchImpl: options.fetchImpl });
	const noop = {
		namespace: 'control-plane', operation: 'noop',
		async run(_input, context) {
			await context.checkpoint({ phase: 'diagnostic' }, { kind: 'control-plane.noop', data: { runnerId: process.env.TREESEED_PLATFORM_RUNNER_ID ?? null } });
			return { ok: true, message: 'Treeseed operations runner diagnostic completed.' };
		},
	};
	const diagnostic = { ...noop, operation: 'diagnostic' };
	return [
		noop,
		diagnostic,
		createFeedbackRetentionExecutor(options),
		createKnowledgePublicationExecutor(options),
		createKnowledgePackExecutor(options),
		createKnowledgePackCleanupExecutor(options),
		createTreeDxCommitReplicationExecutor(options),
		createTreeDxRemoteHeadReconciliationExecutor(options),
		...createHostedTopologyExecutors({ ...options, hostedTopologyAdapter }),
		workflowExecutor,
		workflowConfigurationExecutor,
	].filter((executor) => !options.operationKey || `${executor.namespace}:${executor.operation}` === options.operationKey);
}
