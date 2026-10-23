import { type AgentDefinition, type AssignmentAttempt, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const deny = (message: string): never => { throw Object.assign(new Error(message), { code: 'proposal_contribution_binding_invalid' }); };
type Profile = NonNullable<AgentDefinition['activityProfiles']['acting']> & {
	agentReference: ExactEntityReference; estimateAuthority: ExactEntityReference;
	projectId: string; agentClass: string; definition: AgentDefinition;
};

/** Resolve only verified source attempts supplied by the owning contribution reader. */
export function contributionBindings(source: { teamId: string; frontmatter: Row; estimatingAttempts?: AssignmentAttempt[] },
	profiles: Record<string, AgentDefinition>) {
	const items = (Array.isArray(record(source.frontmatter.executionPlan).workItems)
		? record(source.frontmatter.executionPlan).workItems as Row[] : []).slice().sort((a, b) => text(a.id).localeCompare(text(b.id)));
	const attempts = new Map<string, AssignmentAttempt>();
	for (const attempt of source.estimatingAttempts ?? []) {
		if (attempts.has(attempt.id)) deny('Contributor attempts must have one canonical identity.');
		attempts.set(attempt.id, attempt);
	}
	const author = (item: Row) => {
		const ref = record(item.estimateRef), attempt = attempts.get(text(ref.id));
		if (!attempt || ref.store !== 'postgresql' || ref.model !== 'assignment-attempt' || ref.revision !== attempt.attempt
			|| attempt.teamId !== source.teamId || attempt.sourceRef.model !== 'proposal' || attempt.sourceRef.id !== source.frontmatter.id
			|| attempt.effectiveProfile.activity !== 'estimating') return deny(`Work item ${item.id} lacks its author's verified estimating attempt.`);
		const matches = Object.entries(profiles).filter(([key, definition]) => key.startsWith(`${attempt.projectId}:`)
			&& definition.id === attempt.effectiveProfile.profileRef.id);
		if (matches.length !== 1) return deny(`Work item ${item.id} has no unique configured author.`);
		const definition = matches[0]![1], reference = attempt.effectiveProfile.profileRef;
		if (definition.agentClass !== attempt.agentClass || !definition.groupIds?.some(group =>
			Array.isArray(source.frontmatter.groupIds) && source.frontmatter.groupIds.includes(group))
			|| reference.store !== 'treedx' || reference.model !== 'agent' || !reference.repository || !reference.commit || !reference.path)
			return deny(`Work item ${item.id} author is unsubscribed or lacks exact governed profile custody.`);
		return { attempt, definition, estimateAuthority: ref as ExactEntityReference };
	};
	const owners = new Map(items.map(item => [text(item.id), author(item)]));
	const bind = (item: Row, activity: 'acting' | 'reviewing'): Profile => {
		const owner = owners.get(text(item.id))!, profile = owner.definition.activityProfiles[activity];
		if (!profile) return deny(`Contributor ${owner.definition.id} must configure ${activity} before approval.`);
		return { ...profile, definition: owner.definition, agentClass: owner.definition.agentClass,
			projectId: owner.attempt.projectId, agentReference: owner.attempt.effectiveProfile.profileRef,
			estimateAuthority: owner.estimateAuthority };
	};
	const acting = new Map(items.map(item => [text(item.id), bind(item, 'acting')]));
	const targets = items.filter(item => item.review === 'required');
	const budgets = items.filter(item => Object.keys(record(item.reviewEstimate)).length > 0);
	const targetByBudget = new Map<string, string>();
	const eligible = (target: Row, budget: Row) => {
		const actor = owners.get(text(target.id))!, reviewer = owners.get(text(budget.id))!;
		return actor.attempt.projectId === reviewer.attempt.projectId && actor.definition.id !== reviewer.definition.id
			&& Boolean(reviewer.definition.activityProfiles.reviewing);
	};
	// Each estimated review budget is used once. Matching never invents, scales or
	// duplicates a subscriber's promised effort, and never chooses by role/class.
	const allocate = (target: Row, visited: Set<string>): boolean => {
		for (const budget of budgets) {
			const id = text(budget.id); if (visited.has(id) || !eligible(target, budget)) continue;
			visited.add(id);
			const previous = targetByBudget.get(id);
			if (!previous || allocate(targets.find(item => item.id === previous)!, visited)) {
				targetByBudget.set(id, text(target.id)); return true;
			}
		}
		return false;
	};
	for (const target of targets) if (!allocate(target, new Set())) deny(`Work item ${target.id} lacks a separately estimated independent peer review.`);
	const reviewing = new Map([...targetByBudget].map(([budgetId, targetId]) => {
		const budget = items.find(item => item.id === budgetId)!;
		return [targetId, { profile: bind(budget, 'reviewing'), estimate: record(budget.reviewEstimate), budgetId }] as const;
	}));
	return { acting, reviewing };
}
