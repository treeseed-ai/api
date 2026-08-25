export interface DiscussionHandoffPolicyInput {
	currentAgentId: string;
	recipientAgentIds: string[];
	depth: number;
	maxDepth: number;
	existingHandoffs: number;
	maxHandoffsPerRoot: number;
	priorAgentIds: string[];
	activeDuplicateAgentIds: string[];
}

export interface DiscussionHandoffPolicyViolation {
	code: string;
	message: string;
	details?: Record<string,unknown>;
}

/** Pure policy evaluation used before TreeDX authoring or invocation admission. */
export function discussionHandoffPolicyViolation(input: DiscussionHandoffPolicyInput): DiscussionHandoffPolicyViolation|null {
	const recipients=[...new Set(input.recipientAgentIds.map((value)=>value.trim()).filter(Boolean))];
	if(!recipients.length||recipients.length>2)return {code:'assignment_discussion_handoff_invalid',message:'Discussion handoff requires one or two distinct recipients.'};
	if(recipients.includes(input.currentAgentId))return {code:'assignment_discussion_handoff_self_denied',message:'An agent cannot hand a Discussion to itself.'};
	if(input.depth>input.maxDepth)return {code:'assignment_discussion_handoff_depth_exceeded',message:'Discussion handoff depth exceeds team policy.',details:{depth:input.depth,maxDepth:input.maxDepth}};
	if(input.existingHandoffs+recipients.length>input.maxHandoffsPerRoot)return {code:'assignment_discussion_handoff_root_limit',message:'Discussion handoff root limit is exhausted.'};
	const prior=new Set(input.priorAgentIds);
	if(recipients.some((recipient)=>prior.has(recipient)))return {code:'assignment_discussion_handoff_cycle_denied',message:'Discussion handoff cannot return to an agent already present in its provenance chain.'};
	const duplicates=new Set(input.activeDuplicateAgentIds);
	if(recipients.some((recipient)=>duplicates.has(recipient)))return {code:'assignment_discussion_handoff_duplicate_denied',message:'An exact source/target/subject handoff is already active.'};
	return null;
}
