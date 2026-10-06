import { createHash } from 'node:crypto';
import { validateAgentDefinitionModel, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { parseFrontmatterDocument } from '../../../../content/frontmatter.ts';
import { projectLibraryPath, type KnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';
import { CapacityOperationError } from '../../../../control-plane/repositories/capacity/capacity-operation-error.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export interface AgentDefinitionSourceFile {
	path: string;
	content: string;
	definition: AgentDefinition;
	sourceDigest: string;
}

/** Read and validate one exact governed agent-definition collection. */
export async function snapshotAgentDefinitions(value: KnowledgeGatewayConnection, ref = value.baseRef) {
	const listed = await value.client.listRepositoryPaths({ repoId: value.repositoryId, ref,
		paths: [projectLibraryPath(value.contentPath, 'agents/**')], kinds: ['blob'], extensions: ['.md', '.mdx'], limit: 200, allowProtected: true });
	const commit = text(listed.resolvedRef);
	if (!/^[0-9a-f]{40}$/u.test(commit)) throw new CapacityOperationError(409, 'agent_team_snapshot_invalid',
		'TreeDX did not resolve the agent collection to an exact commit.');
	if (/^[0-9a-f]{40}$/u.test(ref) && commit !== ref) throw new CapacityOperationError(409,
		'agent_team_snapshot_moved', 'Agent collection moved from the requested exact commit.');
	const paths = (Array.isArray(listed.entries) ? listed.entries : []).map((item: unknown) => text(record(item).path)).filter(Boolean).sort();
	if (!paths.length) return { commit, files: [] as AgentDefinitionSourceFile[] };
	const read = await value.client.readRepositoryFiles({ repoId: value.repositoryId, ref: commit, paths,
		encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
	if (text(read.resolvedRef) !== commit) throw new CapacityOperationError(409, 'agent_team_snapshot_moved',
		'Agent definition bytes did not match the listed commit.');
	const readRow = record(read);
	const returned = (Array.isArray(readRow.files) ? readRow.files : Array.isArray(readRow.results) ? readRow.results : []).map(record);
	if (returned.length !== paths.length || new Set(returned.map((file) => text(file.path))).size !== paths.length
		|| returned.some((file) => !paths.includes(text(file.path)))) throw new CapacityOperationError(409,
			'agent_team_snapshot_incomplete', 'TreeDX did not return every exact agent definition in the source snapshot.');
	const files = returned.map((file) => {
		const content = file.content;
		if (typeof content !== 'string') throw new CapacityOperationError(502, 'agent_team_source_missing',
			'TreeDX did not return exact agent definition bytes.');
		const path = text(file.path), validation = validateAgentDefinitionModel(parseFrontmatterDocument(content).frontmatter);
		if (!validation.ok || !validation.data) throw new CapacityOperationError(409, 'agent_team_definition_invalid',
			`Agent definition ${path || '(unknown)'} is invalid; the exact source snapshot cannot be used.`,
			{ path, diagnostics: validation.diagnostics });
		return { path, content, definition: validation.data,
			sourceDigest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
	});
	if (new Set(files.map((file) => file.definition.agentClass)).size !== files.length) throw new CapacityOperationError(409,
		'agent_team_class_ambiguous', 'Multiple agent definitions select the same class.');
	return { commit, files };
}
