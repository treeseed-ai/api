import type { AgentSdk, RemoteSdkOperationRequest } from '@treeseed/sdk';
import { AgentSdk as AgentSdkClass } from '@treeseed/sdk';
import type { ApiConfig } from './types.ts';

type JsonRecord = Record<string, unknown>;

type SdkOperationHandler = (sdk: AgentSdk, input: JsonRecord) => Promise<unknown> | unknown;

interface SdkOperationSpec {
	name: string;
	aliases?: string[];
	handler: SdkOperationHandler;
}

function passthrough<K extends keyof AgentSdk>(
	methodName: K,
): SdkOperationHandler {
	return (sdk, input) => (sdk[methodName] as (request: JsonRecord) => Promise<unknown> | unknown)(input);
}

const SDK_OPERATION_SPECS: SdkOperationSpec[] = [
	{ name: 'get', handler: passthrough('get') },
	{ name: 'read', handler: passthrough('read') },
	{ name: 'search', handler: passthrough('search') },
	{ name: 'follow', handler: passthrough('follow') },
	{ name: 'pick', handler: passthrough('pick') },
	{ name: 'create', handler: passthrough('create') },
	{ name: 'update', handler: passthrough('update') },
	{ name: 'claimMessage', aliases: ['claim-message'], handler: passthrough('claimMessage') },
	{ name: 'ackMessage', aliases: ['ack-message'], handler: passthrough('ackMessage') },
	{ name: 'createMessage', aliases: ['create-message'], handler: passthrough('createMessage') },
	{ name: 'recordRun', aliases: ['record-run'], handler: passthrough('recordRun') },
	{ name: 'getCursor', aliases: ['get-cursor'], handler: passthrough('getCursor') },
	{ name: 'upsertCursor', aliases: ['upsert-cursor'], handler: passthrough('upsertCursor') },
	{ name: 'releaseLease', aliases: ['release-lease'], handler: passthrough('releaseLease') },
	{
		name: 'releaseAllLeases',
		aliases: ['release-all-leases'],
		handler: (sdk) => sdk.releaseAllLeases(),
	},
	{ name: 'startWorkDay', aliases: ['start-work-day'], handler: passthrough('startWorkDay') },
	{ name: 'closeWorkDay', aliases: ['close-work-day'], handler: passthrough('closeWorkDay') },
	{ name: 'createTask', aliases: ['create-task'], handler: passthrough('createTask') },
	{ name: 'claimTask', aliases: ['claim-task'], handler: passthrough('claimTask') },
	{
		name: 'recordTaskProgress',
		aliases: ['record-task-progress'],
		handler: passthrough('recordTaskProgress'),
	},
	{ name: 'completeTask', aliases: ['complete-task'], handler: passthrough('completeTask') },
	{ name: 'failTask', aliases: ['fail-task'], handler: passthrough('failTask') },
	{ name: 'appendTaskEvent', aliases: ['append-task-event'], handler: passthrough('appendTaskEvent') },
	{ name: 'searchTasks', aliases: ['search-tasks'], handler: passthrough('searchTasks') },
	{
		name: 'getManagerContext',
		aliases: ['get-manager-context'],
		handler: (sdk, input) => sdk.getManagerContext(String(input.taskId ?? input.id ?? '')),
	},
	{ name: 'createReport', aliases: ['create-report'], handler: passthrough('createReport') },
	{
		name: 'listAgentSpecs',
		aliases: ['list-agent-specs'],
		handler: (sdk, input) => sdk.listAgentSpecs(input as { enabled?: boolean }),
	},
	{ name: 'refreshGraph', aliases: ['refresh-graph'], handler: passthrough('refreshGraph') },
	{
		name: 'searchFiles',
		aliases: ['search-files'],
		handler: (sdk, input) => sdk.searchFiles(String(input.query ?? ''), input.options as JsonRecord | undefined),
	},
	{
		name: 'searchSections',
		aliases: ['search-sections'],
		handler: (sdk, input) => sdk.searchSections(String(input.query ?? ''), input.options as JsonRecord | undefined),
	},
	{
		name: 'searchEntities',
		aliases: ['search-entities'],
		handler: (sdk, input) => sdk.searchEntities(String(input.query ?? ''), input.options as JsonRecord | undefined),
	},
	{
		name: 'getGraphNode',
		aliases: ['get-graph-node'],
		handler: (sdk, input) => sdk.getGraphNode(String(input.id ?? '')),
	},
	{
		name: 'getNeighbors',
		aliases: ['get-neighbors'],
		handler: (sdk, input) => sdk.getNeighbors(String(input.id ?? ''), input.options as JsonRecord | undefined),
	},
	{
		name: 'followReferences',
		aliases: ['follow-references'],
		handler: (sdk, input) => sdk.followReferences(String(input.id ?? ''), input.options as JsonRecord | undefined),
	},
	{
		name: 'getBacklinks',
		aliases: ['get-backlinks'],
		handler: (sdk, input) => sdk.getBacklinks(String(input.id ?? ''), input.options as JsonRecord | undefined),
	},
	{
		name: 'getRelated',
		aliases: ['get-related'],
		handler: (sdk, input) => sdk.getRelated(String(input.id ?? ''), input.options as JsonRecord | undefined),
	},
	{
		name: 'getSubgraph',
		aliases: ['get-subgraph'],
		handler: (sdk, input) =>
			sdk.getSubgraph(Array.isArray(input.seedIds) ? input.seedIds.map(String) : [], input.options as JsonRecord | undefined),
	},
	{ name: 'resolveSeeds', aliases: ['resolve-seeds'], handler: passthrough('resolveSeeds') },
	{ name: 'queryGraph', aliases: ['query-graph'], handler: passthrough('queryGraph') },
	{ name: 'buildContextPack', aliases: ['build-context-pack'], handler: passthrough('buildContextPack') },
	{
		name: 'parseGraphDsl',
		aliases: ['parse-graph-dsl'],
		handler: (sdk, input) => sdk.parseGraphDsl(String(input.source ?? input.query ?? '')),
	},
	{
		name: 'resolveReference',
		aliases: ['resolve-reference'],
		handler: (sdk, input) =>
			sdk.resolveReference(String(input.reference ?? ''), input.options as JsonRecord | undefined),
	},
	{
		name: 'explainReferenceChain',
		aliases: ['explain-reference-chain'],
		handler: (sdk, input) =>
			sdk.explainReferenceChain(String(input.fromId ?? ''), String(input.toId ?? '')),
	},
];

const SDK_OPERATION_INDEX = new Map<string, SdkOperationSpec>();
for (const spec of SDK_OPERATION_SPECS) {
	SDK_OPERATION_INDEX.set(spec.name, spec);
	for (const alias of spec.aliases ?? []) {
		SDK_OPERATION_INDEX.set(alias, spec);
	}
}

export function listSdkOperationNames() {
	return [...new Set(SDK_OPERATION_SPECS.map((entry) => entry.name))];
}

export function findSdkOperation(name: string) {
	return SDK_OPERATION_INDEX.get(name) ?? null;
}

export function resolveSdkInstance(
	sharedSdk: AgentSdk | undefined,
	config: ApiConfig,
	request: RemoteSdkOperationRequest,
) {
	if (!request.repoRoot || request.repoRoot === config.repoRoot) {
		return sharedSdk ?? new AgentSdkClass({ repoRoot: config.repoRoot });
	}
	return new AgentSdkClass({ repoRoot: request.repoRoot });
}

export async function executeSdkOperation(
	sdk: AgentSdk,
	operationName: string,
	input: JsonRecord,
) {
	const spec = findSdkOperation(operationName);
	if (!spec) {
		throw new Error(`Unknown SDK operation "${operationName}".`);
	}
	return await spec.handler(sdk, input);
}
