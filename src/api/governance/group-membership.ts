export interface GovernanceGroupEdge { fromGroupId: string; toGroupId: string; propagatesMembership?: boolean }
export interface GovernanceGroup { id: string }
export interface EffectiveGroupMembership {
	projectId?: string; directGroupIds: string[]; effectiveGroupIds: string[];
	provenance: Array<{ groupId: string; kind: 'direct' | 'inherited' | 'subject'; viaGroupIds: string[]; sourceEntityRefs: string[] }>;
}

function unique(values: string[]) { return [...new Set(values.filter(Boolean))].sort(); }

export function validateGovernanceGroupGraph(groups: GovernanceGroup[], edges: GovernanceGroupEdge[]) {
	const ids = new Set(groups.map((group) => group.id)); if (ids.size !== groups.length) throw new Error('Group IDs must be unique.');
	const parents = new Map<string, string[]>(); for (const edge of edges) { if (!ids.has(edge.fromGroupId) || !ids.has(edge.toGroupId)) throw new Error('A group edge references an unknown group.'); if (edge.propagatesMembership) parents.set(edge.fromGroupId, [...(parents.get(edge.fromGroupId) ?? []), edge.toGroupId]); }
	const visiting = new Set<string>(); const visited = new Set<string>(); const visit = (id: string) => { if (visiting.has(id)) throw new Error(`Membership-propagating group edge creates a cycle at ${id}.`); if (visited.has(id)) return; visiting.add(id); for (const parent of parents.get(id) ?? []) visit(parent); visiting.delete(id); visited.add(id); };
	for (const id of ids) visit(id);
}

export function resolveEffectiveGroupMembership(input: { projectId?: string; directGroupIds: string[]; edges: GovernanceGroupEdge[]; subjects?: Array<{ ref: string; membership: EffectiveGroupMembership }> }): EffectiveGroupMembership {
	const parents = new Map<string, string[]>(); for (const edge of input.edges.filter((candidate) => candidate.propagatesMembership)) parents.set(edge.fromGroupId, [...(parents.get(edge.fromGroupId) ?? []), edge.toGroupId]);
	const provenance = new Map<string, EffectiveGroupMembership['provenance'][number]>();
	const inherit = (groupId: string, path: string[], sourceEntityRefs: string[], kind: EffectiveGroupMembership['provenance'][number]['kind']) => { if (!provenance.has(groupId)) provenance.set(groupId, { groupId, kind, viaGroupIds: path, sourceEntityRefs }); for (const parent of parents.get(groupId) ?? []) inherit(parent, [...path, groupId], sourceEntityRefs, kind === 'direct' ? 'inherited' : kind); };
	for (const groupId of unique(input.directGroupIds)) inherit(groupId, [], [], 'direct'); for (const subject of input.subjects ?? []) for (const groupId of subject.membership.effectiveGroupIds) inherit(groupId, [], [subject.ref], 'subject');
	return { projectId: input.projectId, directGroupIds: unique(input.directGroupIds), effectiveGroupIds: [...provenance.keys()].sort(), provenance: [...provenance.values()].sort((left, right) => left.groupId.localeCompare(right.groupId)) };
}
