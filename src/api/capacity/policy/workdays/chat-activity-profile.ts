import type { AgentActivityProfile,AgentChatProfileConfiguration } from '@treeseed/sdk/types/agents';

export function compileDefaultChatActivityProfile(
	agentSlug: string,
	specialization: AgentChatProfileConfiguration = { foundation: 'discussion-v1' },
): AgentActivityProfile {
	// Discussion responses are authored only by treeseed.discussion.respond.
	// Generic content tools retain custody only for explicitly linked artifacts
	// and the assignment's own operational records.
	const writableModels = new Set(['note', 'question', 'proposal', 'assignment_plan', 'assignment_status', 'assignment_summary']);
	const contextModels = [...new Set([
		'discussion', 'discussion_message', 'discussion_event', 'discussion_topic', 'agent', 'note', 'question',
		'proposal', 'decision', 'objective', 'knowledge', 'assignment_plan', 'assignment_status', 'assignment_summary',
		...(specialization.contextModels ?? []),
	])];
	const tools = [...new Set([
		'treeseed.content.describe', 'treeseed.content.query', 'treeseed.content.read', 'treedx.build_context',
		'treedx.read_repository_files', 'treedx.search_workspace', 'treedx.read_workspace_file',
		'treeseed.repository.read_file', 'treeseed.repository.search',
		'treeseed.content.create', 'treeseed.content.update', 'treeseed.content.link', 'treeseed.content.validate',
		'treeseed.content.commit', 'treeseed.status', 'treeseed.assignment_activity', 'treeseed.assignment_plan',
		'treeseed.assignment_status_update', 'treeseed.assignment_summary', 'treeseed.discussion.read',
		'treeseed.discussion.follow', 'treeseed.discussion.respond', 'treeseed.discussion.request_handoff',
		'treeseed.discussion.create_artifact', 'treeseed.operation.prepare_handoff', 'treeseed.client_session.request_action',
		...(specialization.toolAdditions ?? []),
	])];
	return {
		enabled: true,
		handler: 'writer',
		prompt: {
			system: `Participate as ${agentSlug} in a TreeSeed Discussion. Begin at the exact project repository root, read its AGENTS.md, and inspect source, scripts, tests, and CI whenever the question depends on implementation evidence. Use the assignment's exact project TreeDX library as the default knowledge context. Answer from your configured identity and durable instructions, cite exact TreeDX content or repository refs, distinguish evidence from inference, and keep the response scoped to the current turn. If either repository or TreeDX read context is missing, report an execution-context defect instead of asking the user to supply files owned by the project. You may create or update discussion messages, linked notes, questions, and proposals. Questions must declare their owning project, requested audience, related objectives, and answer policy so they can enter the team inbox. Proposals must declare their owning project, proposal type, evidence, objective links, and complete plan; never describe a proposal as approved until an exact-version governed inbox action accepts it. When human input is required, create a durable question instead of burying the request in prose. Never change knowledge or code without an approved governed acting assignment.${specialization.responseStyle ? ` Response style: ${specialization.responseStyle}` : ''}`,
			task: specialization.promptTask ?? 'Respond to the committed Discussion turn and produce durable, source-grounded output.',
		},
		branchPolicy: { kind: 'staging-content', base: 'staging' },
		permissions: {
			content: Object.fromEntries(contextModels.map((model) => [model, {
				operations: writableModels.has(model) ? ['describe', 'query', 'read', 'create', 'update', 'link', 'validate', 'commit'] : ['describe', 'query', 'read'],
			}])),
			commit: { allowed: true },
		},
		tools: { allowed: tools },
		outputs: {
			messageTypes: ['discussion_response'],
			modelMutations: ['discussion_message:create', 'linked_note:create', 'question:create', 'proposal:create'],
		},
		planningIntent: {
			stage: 'deliberation',
			objective: 'Respond to the exact committed Discussion turn with a durable, correctly addressed message.',
			artifactKind: 'discussion_response',
			subjectModel: 'discussion_message',
			subjectId: null,
		},
		questionPolicy: { blockExecutionWhenCreated: false, defaultAnswerPolicy: { kind: 'team-human' } },
		execution: {
			requiredCapabilities: specialization.requiredCapabilities ?? ['agent-execution'],
			maxRuntimeSeconds: specialization.maxRuntimeSeconds ?? 900, maxRetries: 1, verificationRequired: false,
			maxTotalTokens: specialization.maxTotalTokens ?? 136_000, warningTokens: specialization.warningTokens ?? 100_000,
			maxCostAmount: specialization.maxCostAmount, costCurrency: specialization.costCurrency ?? 'USD',
			pricingGeneration: 'provider-runtime', enforcementConfidence: 'bounded', closeoutWarningSeconds: 180,
		},
	};
}
