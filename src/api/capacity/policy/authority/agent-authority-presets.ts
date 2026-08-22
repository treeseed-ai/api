import type { AgentActivityPermissions,AgentActivityProfile,AgentActivityType,AgentToolPolicy } from '@treeseed/sdk/types/agents';

export const AGENT_AUTHORITY_PRESET_IDS = [
	'messaging', 'direction', 'influence', 'estimation', 'plan-contribution',
	'source-execution', 'review-authority', 'reporting',
] as const;

export type AgentAuthorityPresetId = (typeof AGENT_AUTHORITY_PRESET_IDS)[number];

const OPERATIONAL_TOOLS = ['treeseed.status','treeseed.assignment_activity','treeseed.assignment_plan','treeseed.assignment_status_update','treeseed.assignment_summary'];
const MESSAGING_TOOLS = ['treeseed.discussion.read','treeseed.discussion.follow','treeseed.discussion.respond','treeseed.discussion.request_handoff'];
const CONTENT_TOOLS = ['treeseed.content.describe','treeseed.content.query','treeseed.content.read','treeseed.content.create','treeseed.content.update','treeseed.content.link','treeseed.content.validate','treeseed.content.commit'];
const SOURCE_READ_TOOLS = ['treeseed.repository.read_file','treeseed.repository.search','treeseed.changed_paths','treeseed.verify'];
const SOURCE_EXECUTION_TOOLS = [...SOURCE_READ_TOOLS,'treeseed.checkpoint'];
const RAW_CONTENT_MUTATION_TOOLS = new Set(['treedx.apply_workspace_changeset','treedx.commit_workspace']);
const CHAT_ALLOWED_TOOLS = new Set([
	...OPERATIONAL_TOOLS, ...MESSAGING_TOOLS, ...CONTENT_TOOLS,
	'treedx.build_context', 'treedx.read_repository_files', 'treedx.search_workspace', 'treedx.read_workspace_file',
	'treeseed.discussion.create_artifact', 'treeseed.operation.prepare_handoff', 'treeseed.client_session.request_action',
]);

const PROFILE_PRESETS: Record<AgentActivityType,AgentAuthorityPresetId[]> = {
	planning: ['influence','plan-contribution'],
	estimating: ['messaging','estimation'],
	acting: ['source-execution','influence'],
	reviewing: ['review-authority','plan-contribution'],
	reporting: ['messaging','reporting'],
	chat: ['influence'],
};

function toolsForPreset(preset: AgentAuthorityPresetId) {
	if (preset === 'messaging') return MESSAGING_TOOLS;
	if (preset === 'direction') return CONTENT_TOOLS;
	if (preset === 'influence') return [...MESSAGING_TOOLS,...CONTENT_TOOLS];
	if (preset === 'estimation') return MESSAGING_TOOLS;
	if (preset === 'plan-contribution') return [];
	if (preset === 'source-execution') return SOURCE_EXECUTION_TOOLS;
	if (preset === 'review-authority') return [...MESSAGING_TOOLS,...CONTENT_TOOLS,...SOURCE_READ_TOOLS];
	return [...MESSAGING_TOOLS,...CONTENT_TOOLS];
}

export interface CompiledAgentAuthoritySnapshot {
	presetIds: AgentAuthorityPresetId[];
	permissions?: AgentActivityPermissions;
	tools: AgentToolPolicy;
	branchPolicy: AgentActivityProfile['branchPolicy'];
	diagnostics: string[];
}

const OPERATIONAL_MODELS = new Set(['assignment_plan','assignment_status','assignment_summary']);
const MUTABLE_MODELS:Record<AgentActivityType,Set<string>>={
	planning:new Set(['proposal','question','note','discussion_message',...OPERATIONAL_MODELS]),
	estimating:new Set(['note','question','discussion_message',...OPERATIONAL_MODELS]),
	acting:new Set<string>(),
	reviewing:new Set(['note','question','discussion_message',...OPERATIONAL_MODELS]),
	reporting:new Set(['note','discussion_message',...OPERATIONAL_MODELS]),
	chat:new Set(['proposal','question','note','discussion_message',...OPERATIONAL_MODELS]),
};

function boundedPermissions(activityType:AgentActivityType,permissions:AgentActivityPermissions|undefined) {
	if(!permissions) return permissions;
	const content=Object.fromEntries(Object.entries(permissions.content??{}).map(([model,policy])=>{
		if(activityType==='acting'||MUTABLE_MODELS[activityType].has(model)) return [model,policy];
		return [model,{...policy,operations:policy.operations.filter((operation)=>['describe','query','read','validate'].includes(operation))}];
	}).filter(([,policy])=>(policy as {operations:string[]}).operations.length));
	if(activityType==='acting') return {...permissions,content};
	return {...permissions,content,repository:{...(permissions.repository??{}),writePaths:[],allowCodeMutation:false},
		commit:{allowed:Object.entries(content).some(([model,policy])=>MUTABLE_MODELS[activityType].has(model)&&(policy.operations.includes('create')||policy.operations.includes('update')||policy.operations.includes('link')||policy.operations.includes('commit')))},
		network:permissions.network,shell:{...(permissions.shell??{}),allowCommands:false,allowedCommands:[]}};
}

export function defaultAgentAuthorityPresets(activityType: AgentActivityType) {
	return [...PROFILE_PRESETS[activityType]];
}

export function compileAgentAuthoritySnapshot(activityType: AgentActivityType, profile: AgentActivityProfile): CompiledAgentAuthoritySnapshot {
	const declared = profile.authorityPresets?.length ? profile.authorityPresets : defaultAgentAuthorityPresets(activityType);
	const presetIds = [...new Set(declared)];
	const diagnostics: string[] = [];
	for (const preset of presetIds) if (!AGENT_AUTHORITY_PRESET_IDS.includes(preset)) diagnostics.push(`Unknown authority preset ${preset}.`);
	const declaredTools = [...new Set([...OPERATIONAL_TOOLS,...presetIds.flatMap(toolsForPreset),...(profile.tools?.allowed ?? [])])];
	const hasModelAwareContentMutation = declaredTools.some((tool) => /^treeseed\.content\.(?:create|update|link|commit)$/u.test(tool));
	const allowed = hasModelAwareContentMutation
		? declaredTools.filter((tool) => !RAW_CONTENT_MUTATION_TOOLS.has(tool))
		: declaredTools;
	const denied = new Set(profile.tools?.denied ?? []);
	const profileAllowed=activityType==='acting'?allowed:activityType==='reviewing'
		? allowed.filter((tool)=>tool!=='treeseed.checkpoint')
		: activityType==='chat' ? allowed.filter((tool)=>CHAT_ALLOWED_TOOLS.has(tool))
			: allowed.filter((tool)=>tool!=='treeseed.checkpoint'&&!tool.startsWith('treeseed.repository.')&&tool!=='treeseed.changed_paths'&&tool!=='treeseed.verify');
	if(activityType==='chat')for(const tool of allowed)if(!CHAT_ALLOWED_TOOLS.has(tool))diagnostics.push(`Chat cannot use ${tool}.`);
	const tools = { allowed: profileAllowed.filter((tool) => !denied.has(tool)), ...(denied.size ? { denied: [...denied] } : {}) };
	if (activityType !== 'acting' && profile.permissions?.repository?.allowCodeMutation === true) diagnostics.push(`${activityType} cannot enable repository code mutation.`);
	if (activityType === 'reviewing' && tools.allowed.includes('treeseed.checkpoint')) diagnostics.push('Review authority cannot checkpoint or modify the reviewed implementation.');
	if (activityType === 'acting' && profile.permissions?.repository?.allowCodeMutation !== true && profile.permissions?.commit?.allowed !== true) diagnostics.push('Acting requires explicit source-mutation or governed content-commit authority.');
	const permissions=boundedPermissions(activityType,profile.permissions);
	// Content-capable profiles still need their governed TreeDX assignment branch.
	// Repository branch mutation is denied by the tool and repository policies;
	// replacing the declared content branch with read-only here would prevent
	// Planning, Reviewing, Reporting, and Chat from writing their permitted
	// proposal, finding, report, and discussion artifacts.
	const branchPolicy=profile.branchPolicy;
	return { presetIds, permissions, tools, branchPolicy, diagnostics };
}

export function allowedSafetyModesForActivity(activityType: AgentActivityType): Array<'planning'|'acting'> {
	if (activityType === 'acting') return ['acting'];
	if (activityType === 'reviewing') return ['planning','acting'];
	return ['planning'];
}
