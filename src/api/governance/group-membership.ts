export interface GovernanceGroupEdge { fromGroupId: string; toGroupId: string; propagatesMembership?: boolean }
export interface EffectiveGroupMembership {
	projectId?: string; directGroupIds: string[]; effectiveGroupIds: string[];
	provenance: Array<{ groupId: string; kind: 'direct' | 'inherited' | 'subject'; viaGroupIds: string[]; sourceEntityRefs: string[] }>;
}

function unique(values: string[]) { return [...new Set(values.filter(Boolean))].sort(); }

export function resolveEffectiveGroupMembership(input: { projectId?: string; directGroupIds: string[]; edges: GovernanceGroupEdge[]; subjects?: Array<{ ref: string; membership: EffectiveGroupMembership }> }): EffectiveGroupMembership {
	const parents = new Map<string, string[]>(); for (const edge of input.edges.filter((candidate) => candidate.propagatesMembership)) parents.set(edge.fromGroupId, [...(parents.get(edge.fromGroupId) ?? []), edge.toGroupId]);
	const provenance = new Map<string, EffectiveGroupMembership['provenance'][number]>();
	const inherit = (groupId: string, path: string[], sourceEntityRefs: string[], kind: EffectiveGroupMembership['provenance'][number]['kind']) => { if (!provenance.has(groupId)) provenance.set(groupId, { groupId, kind, viaGroupIds: path, sourceEntityRefs }); for (const parent of parents.get(groupId) ?? []) inherit(parent, [...path, groupId], sourceEntityRefs, kind === 'direct' ? 'inherited' : kind); };
	for (const groupId of unique(input.directGroupIds)) inherit(groupId, [], [], 'direct'); for (const subject of input.subjects ?? []) for (const groupId of subject.membership.effectiveGroupIds) inherit(groupId, [], [subject.ref], 'subject');
	return { projectId: input.projectId, directGroupIds: unique(input.directGroupIds), effectiveGroupIds: [...provenance.keys()].sort(), provenance: [...provenance.values()].sort((left, right) => left.groupId.localeCompare(right.groupId)) };
}
