import type {
	EffectiveGroupMembership,
	GroupScopeMatch,
	SignalGroupScope,
} from '@treeseed/sdk/agent-capacity';

function shared(left: string[], right: string[]) {
	const rightIds = new Set(right);
	return [...new Set(left.filter((id) => rightIds.has(id)))].sort();
}

function mostSpecific(ids: string[], depthByGroupId: Record<string, number>) {
	if (!ids.length) return { id: null, ambiguous: false };
	const greatestDepth = Math.max(...ids.map((id) => depthByGroupId[id] ?? 0));
	const candidates = ids.filter((id) => (depthByGroupId[id] ?? 0) === greatestDepth);
	return { id: candidates.length === 1 ? candidates[0] : null, ambiguous: candidates.length > 1 };
}

export function matchSignalGroupScope(input: {
	scope: SignalGroupScope;
	agentMembership: EffectiveGroupMembership;
	subjectMembership: EffectiveGroupMembership;
	depthByGroupId?: Record<string, number>;
}): GroupScopeMatch {
	const { scope, agentMembership, subjectMembership } = input;
	const projectId = subjectMembership.projectId;
	if (scope.mode === 'project') {
		const matched = projectId === scope.projectId && (!agentMembership.projectId || agentMembership.projectId === scope.projectId);
		return { matched, coordinationGroupId: null, matchedGroupIds: [], reason: matched ? 'project' : 'outside-scope' };
	}
	if (agentMembership.projectId && projectId && agentMembership.projectId !== projectId) {
		return { matched: false, coordinationGroupId: null, matchedGroupIds: [], reason: 'outside-scope' };
	}
	const effective = shared(agentMembership.effectiveGroupIds, subjectMembership.effectiveGroupIds);
	if (scope.mode === 'specific-groups') {
		const allowed = new Set(scope.groupRefs.filter((ref) => !projectId || ref.projectId === projectId).map((ref) => ref.groupId));
		const subjectGroups = scope.includeDescendants ? subjectMembership.effectiveGroupIds : subjectMembership.directGroupIds;
		const matches = shared(agentMembership.effectiveGroupIds, subjectGroups).filter((id) => allowed.has(id));
		const selection = mostSpecific(matches, input.depthByGroupId ?? {});
		return {
			matched: matches.length > 0 && !selection.ambiguous,
			coordinationGroupId: selection.id,
			matchedGroupIds: matches,
			reason: selection.ambiguous ? 'ambiguous' : matches.length ? 'explicit' : 'outside-scope',
		};
	}
	const direct = shared(agentMembership.directGroupIds, subjectMembership.directGroupIds);
	const directSelection = mostSpecific(direct, input.depthByGroupId ?? {});
	if (directSelection.ambiguous) return { matched: false, coordinationGroupId: null, matchedGroupIds: direct, reason: 'ambiguous' };
	if (directSelection.id) return { matched: true, coordinationGroupId: directSelection.id, matchedGroupIds: direct, reason: 'shared-direct' };
	const effectiveSelection = mostSpecific(effective, input.depthByGroupId ?? {});
	if (effectiveSelection.ambiguous) return { matched: false, coordinationGroupId: null, matchedGroupIds: effective, reason: 'ambiguous' };
	return {
		matched: Boolean(effectiveSelection.id),
		coordinationGroupId: effectiveSelection.id,
		matchedGroupIds: effective,
		reason: effectiveSelection.id ? 'shared-effective' : 'outside-scope',
	};
}
