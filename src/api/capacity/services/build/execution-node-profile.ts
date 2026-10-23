import { effectiveActivityProfileSchema, validateAgentDefinitionModel, type EffectiveActivityProfile, type ExecutionNode } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../database.ts';
import { resolveKnowledgeGatewayConnection } from '../../../knowledge/gateway-treedx-connection.ts';
import { agentProfileReference } from '../../policy/execution/agent-profile-reference.ts';
type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
 if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
 if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
 return {};
};
const array = (value: unknown): unknown[] => {
 if (Array.isArray(value)) return value;
 if (typeof value === 'string') try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
 return [];
};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const stable = (value: unknown): string => {
 if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
 if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
 return JSON.stringify(value);
};

export async function effectiveProfile(store: any, node: ExecutionNode): Promise<{ projectAgentClassId: string; profile: EffectiveActivityProfile }> {
	const identities = (node.authorityRefs ?? []).filter(reference => ['postgresql','treedx'].includes(reference.store) && reference.model === 'agent');
	if (identities.length !== 1) throw new CapacityGovernanceError('execution_node_agent_identity_missing',
		`Ready node ${node.id} requires one derived contributor identity.`, 409);
	const identity = identities[0]!;
	const rows = await store.all(`SELECT id,status,handler_refs_json,metadata_json FROM project_agent_classes
		WHERE project_id=? ORDER BY id`, [node.projectId]);
	const matches = rows.flatMap((row: Row) => array(record(row.handler_refs_json).agents).flatMap((candidate, index) => {
		const validation = validateAgentDefinitionModel(candidate);
		return validation.ok && validation.data?.id === identity.id ? [{ row, index, definition: validation.data }] : [];
	}));
	if (matches.length !== 1) throw new CapacityGovernanceError('execution_node_agent_identity_ambiguous',
		`Ready node ${node.id} contributor identity is missing or duplicated.`, 409);
	for (const { row, index, definition } of matches) {
		if (definition.agentClass !== node.agentClass || (identity.digest
			? identity.digest !== agentProfileReference(definition).digest
			: !identity.commit || !identity.repository || !identity.path)) throw new CapacityGovernanceError(
			'execution_node_agent_identity_moved', `Ready node ${node.id} contributor differs from its derived authority.`, 409);
		if (row.status && row.status !== 'active') throw new CapacityGovernanceError('execution_node_agent_class_unavailable',
			`Contributor ${identity.id} is present but allocation class ${text(row.id)} is ${text(row.status)}.`, 409);
		const activity = node.kind === 'communication' ? 'chat' : node.kind;
		if (!['planning','estimating','acting','reviewing','reporting','chat'].includes(activity)) continue;
		const metadata = record(row.metadata_json);
		const commit = text(metadata.immutableRef);
		const path = text(array(metadata.definitionPaths)[index]);
		if (metadata.source !== 'project-library' || !/^[a-f0-9]{40}$/u.test(commit) || !path) {
			throw new CapacityGovernanceError('execution_node_agent_profile_unpinned',
				`Agent class ${text(row.id)} lacks an exact project-library definition.`, 409);
		}
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: node.projectId, write: false, readRefs: [commit], workspacePaths: [path],
		});
		if (!connection) throw new CapacityGovernanceError('execution_node_agent_profile_unavailable',
			`Agent class ${text(row.id)} project library is unavailable.`, 409);
		if (identity.commit && (identity.commit !== commit || identity.path !== path || identity.repository !== connection.repositoryId)) {
			throw new CapacityGovernanceError('execution_node_agent_identity_moved',
				`Ready node ${node.id} contributor no longer matches its exact admitted profile.`, 409);
		}
		const response = record(await connection.client.readRepositoryFile({
			repoId: connection.repositoryId, ref: commit, path,
			encoding: 'utf8', parseFrontmatter: true, allowProtected: true,
		}));
		const file = record(response.file ?? (Array.isArray(response.files) ? response.files[0] : null));
		const exact = validateAgentDefinitionModel(record(file.frontmatter));
		if (text(response.resolvedRef) !== commit || text(file.path) !== path
			|| !exact.ok || !exact.data || stable(exact.data) !== stable(definition)) {
			throw new CapacityGovernanceError('execution_node_agent_profile_moved',
				`Agent class ${text(row.id)} differs from its exact project-library definition.`, 409);
		}
		const selected = exact.data.activityProfiles[activity as keyof typeof exact.data.activityProfiles];
		if (!selected) continue;
		return {
			projectAgentClassId: text(row.id),
			profile: effectiveActivityProfileSchema.parse({
				handler: selected.handler,
				prompt: selected.prompt,
				...(selected.additionalContext ? { additionalContext: selected.additionalContext } : {}),
				...(selected.parameters ? { parameters: selected.parameters } : {}),
				profileRef: { store: 'treedx', model: 'agent', id: exact.data.id,
					repository: connection.repositoryId, commit, path },
				activity,
				handlerOrigin: selected.handler.includes('/') ? 'project-runtime' : 'agent-package',
				permissionCeiling: selected.permissions,
			}),
		};
	}
	throw new CapacityGovernanceError('execution_node_agent_profile_missing',
		`Ready node ${node.id} has no exact active ${node.agentClass} ${node.kind} profile.`, 409);
}

