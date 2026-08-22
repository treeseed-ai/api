export type GovernanceScope = 'project' | 'commons' | 'team';
export type GovernanceVoteValue = 'support' | 'object' | 'abstain';
export type GovernanceOutcomeStatus = 'voting' | 'accepted' | 'rejected' | 'no_decision_quorum_failed';
export type GovernanceOutcomeReason =
	| 'support_threshold_met'
	| 'object_threshold_met'
	| 'deadline_support_failed'
	| 'deadline_quorum_failed'
	| 'admin_approved'
	| 'admin_rejected'
	| 'manual_override'
	| 'still_open';

export interface GovernanceRuleInput {
	teamId: string;
	projectId?: string | null;
	scope: GovernanceScope;
	proposalType?: string | null;
	providerConfig: Record<string, unknown>;
}

export interface GovernanceRuleDescription {
	providerId: string;
	providerVersion: string;
	label: string;
	summary: string;
	config: Record<string, unknown>;
}

export interface GovernanceChamberSnapshot {
	id: string;
	label: string;
	kind: 'member_equal' | 'stake_weighted' | 'admin' | 'custom';
	eligibleWeightTotal: number;
	activeWeightTotal: number;
	quorumWeightRequired: number;
	supportWeightRequired: number;
	objectWeightRequired?: number;
}

export interface GovernanceEligibleVoter {
	userId: string;
	participantId?: string | null;
	teamMemberId?: string | null;
	activeForQuorum: boolean;
	chambers: Array<{
		chamberId: string;
		eligible: boolean;
		weight: number;
		source: string;
		evidence: Record<string, unknown>;
	}>;
}

export interface GovernanceDelegationSnapshot {
	id: string;
	fromUserId: string;
	toUserId: string;
	scope: string;
	chambers: string[];
	status: 'active' | 'revoked' | 'expired' | string;
	reason?: string | null;
	createdAt?: string | null;
}

export interface GovernanceElectorateInput extends GovernanceRuleInput {
	eligibleVoters: GovernanceEligibleVoter[];
	delegations?: GovernanceDelegationSnapshot[];
	createdAt?: string;
}

export interface GovernanceElectorateSnapshot {
	providerId: string;
	providerVersion: string;
	ruleSnapshot: Record<string, unknown>;
	chambers: GovernanceChamberSnapshot[];
	eligibleVoters: GovernanceEligibleVoter[];
	delegations: GovernanceDelegationSnapshot[];
	createdAt: string;
}

export interface GovernanceVoteInput {
	proposalId: string;
	proposalVersion: number;
	userId: string;
	vote: GovernanceVoteValue;
	reason?: string | null;
	chamberOverrides?: Record<string, unknown>;
}

export interface GovernanceVoteRecord {
	proposalId: string;
	proposalVersion: number;
	userId: string;
	vote: GovernanceVoteValue;
	reason: string | null;
	chamberVotes: Record<string, GovernanceVoteValue>;
}

export interface GovernanceEvaluationVote {
	userId: string;
	vote: GovernanceVoteValue;
	weight?: number;
	reason?: string | null;
	chamberVotes?: Record<string, GovernanceVoteValue>;
	effectiveWeights?: Record<string, number>;
	delegatedFrom?: string[];
}

export interface GovernanceEvaluationInput {
	now?: string;
	votingEndsAt?: string | null;
	electorate: GovernanceElectorateSnapshot;
	votes: GovernanceEvaluationVote[];
	adminDecision?: 'approved' | 'rejected' | 'request_changes' | null;
}

export interface GovernanceChamberResult {
	chamberId: string;
	label: string;
	status: GovernanceOutcomeStatus;
	supportWeight: number;
	objectWeight: number;
	abstainWeight: number;
	participatingWeight: number;
	quorumWeightRequired: number;
	supportWeightRequired: number;
	objectWeightRequired?: number;
	quorumMet: boolean;
	reasonCode: GovernanceOutcomeReason;
}

export interface GovernanceOutcome {
	status: GovernanceOutcomeStatus;
	reasonCode: GovernanceOutcomeReason;
	chamberResults: GovernanceChamberResult[];
	voteResult: Record<string, unknown>;
	decisionEligible: boolean;
}

export interface GovernanceVotingProvider {
	id: string;
	label: string;
	version: string;
	describeRule(input: GovernanceRuleInput): GovernanceRuleDescription;
	snapshotElectorate(input: GovernanceElectorateInput): Promise<GovernanceElectorateSnapshot> | GovernanceElectorateSnapshot;
	normalizeVote(input: GovernanceVoteInput): GovernanceVoteRecord;
	evaluate(input: GovernanceEvaluationInput): GovernanceOutcome;
}

function numberConfig(config: Record<string, unknown>, key: string, fallback: number): number {
	const value = Number(config[key]);
	return Number.isFinite(value) ? value : fallback;
}

function objectConfig(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function chamberConfig(config: Record<string, unknown>, key: string, fallback: Record<string, unknown>) {
	return { ...fallback, ...objectConfig(config[key]) };
}

function clampRatio(value: number) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function activeWeightFor(chamberId: string, voters: GovernanceEligibleVoter[]) {
	return voters
		.filter((voter) => voter.activeForQuorum)
		.reduce((total, voter) => total + (voter.chambers.find((entry) => entry.chamberId === chamberId && entry.eligible)?.weight ?? 0), 0);
}

function eligibleWeightFor(chamberId: string, voters: GovernanceEligibleVoter[]) {
	return voters.reduce((total, voter) => total + (voter.chambers.find((entry) => entry.chamberId === chamberId && entry.eligible)?.weight ?? 0), 0);
}

function standardVote(input: GovernanceVoteInput): GovernanceVoteRecord {
	return {
		proposalId: input.proposalId,
		proposalVersion: input.proposalVersion,
		userId: input.userId,
		vote: input.vote,
		reason: input.reason ?? null,
		chamberVotes: objectConfig(input.chamberOverrides) as Record<string, GovernanceVoteValue>,
	};
}

function voteForChamber(vote: GovernanceEvaluationVote, chamberId: string): GovernanceVoteValue {
	const value = vote.chamberVotes?.[chamberId];
	return value === 'support' || value === 'object' || value === 'abstain' ? value : vote.vote;
}

function weightForChamber(vote: GovernanceEvaluationVote, voter: GovernanceEligibleVoter | undefined, chamberId: string): number {
	const explicit = vote.effectiveWeights?.[chamberId];
	if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
	const chamber = voter?.chambers.find((entry) => entry.chamberId === chamberId && entry.eligible);
	return chamber?.weight ?? vote.weight ?? 0;
}

function evaluateChambers(input: GovernanceEvaluationInput): GovernanceChamberResult[] {
	const voterById = new Map(input.electorate.eligibleVoters.map((voter) => [voter.userId, voter]));
	return input.electorate.chambers.map((chamber) => {
		let supportWeight = 0;
		let objectWeight = 0;
		let abstainWeight = 0;
		for (const vote of input.votes) {
			const voter = voterById.get(vote.userId);
			const weight = weightForChamber(vote, voter, chamber.id);
			if (weight <= 0) continue;
			const value = voteForChamber(vote, chamber.id);
			if (value === 'support') supportWeight += weight;
			else if (value === 'object') objectWeight += weight;
			else abstainWeight += weight;
		}
		const participatingWeight = supportWeight + objectWeight + abstainWeight;
		const quorumMet = participatingWeight >= chamber.quorumWeightRequired;
		let status: GovernanceOutcomeStatus = 'voting';
		let reasonCode: GovernanceOutcomeReason = 'still_open';
		if (quorumMet && supportWeight >= chamber.supportWeightRequired) {
			status = 'accepted';
			reasonCode = 'support_threshold_met';
		} else if (quorumMet && chamber.objectWeightRequired != null && objectWeight >= chamber.objectWeightRequired) {
			status = 'rejected';
			reasonCode = 'object_threshold_met';
		}
		return {
			chamberId: chamber.id,
			label: chamber.label,
			status,
			supportWeight,
			objectWeight,
			abstainWeight,
			participatingWeight,
			quorumWeightRequired: chamber.quorumWeightRequired,
			supportWeightRequired: chamber.supportWeightRequired,
			objectWeightRequired: chamber.objectWeightRequired,
			quorumMet,
			reasonCode,
		};
	});
}

function votingEnded(input: GovernanceEvaluationInput) {
	return Boolean(input.votingEndsAt && Date.parse(input.now ?? new Date().toISOString()) >= Date.parse(input.votingEndsAt));
}

function outcome(status: GovernanceOutcomeStatus, reasonCode: GovernanceOutcomeReason, chamberResults: GovernanceChamberResult[]): GovernanceOutcome {
	return {
		status,
		reasonCode,
		chamberResults,
		voteResult: {
			chambers: chamberResults,
			supportWeight: chamberResults.reduce((total, result) => total + result.supportWeight, 0),
			objectWeight: chamberResults.reduce((total, result) => total + result.objectWeight, 0),
			abstainWeight: chamberResults.reduce((total, result) => total + result.abstainWeight, 0),
		},
		decisionEligible: status === 'accepted',
	};
}

function baseSnapshot(provider: GovernanceVotingProvider, input: GovernanceElectorateInput, chambers: GovernanceChamberSnapshot[]): GovernanceElectorateSnapshot {
	return {
		providerId: provider.id,
		providerVersion: provider.version,
		ruleSnapshot: provider.describeRule(input).config,
		chambers,
		eligibleVoters: input.eligibleVoters,
		delegations: input.delegations ?? [],
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
}

const ADMIN_CONFIG = { quorumPercent: 0, supportThreshold: 1, rejectThreshold: 1 };

export const adminApprovalProvider: GovernanceVotingProvider = {
	id: 'admin_approval_v1',
	label: 'Admin approval',
	version: '1',
	describeRule(input) {
		return { providerId: this.id, providerVersion: this.version, label: this.label, summary: 'A project or team manager approves or rejects the proposal.', config: { ...ADMIN_CONFIG, ...input.providerConfig } };
	},
	snapshotElectorate(input) {
		const chamber: GovernanceChamberSnapshot = {
			id: 'admin_chamber',
			label: 'Admin approval',
			kind: 'admin',
			eligibleWeightTotal: 1,
			activeWeightTotal: 1,
			quorumWeightRequired: 0,
			supportWeightRequired: 1,
			objectWeightRequired: 1,
		};
		return baseSnapshot(this, input, [chamber]);
	},
	normalizeVote: standardVote,
	evaluate(input) {
		const chamberResults = evaluateChambers(input);
		if (input.adminDecision === 'approved') return outcome('accepted', 'admin_approved', chamberResults);
		if (input.adminDecision === 'rejected' || input.adminDecision === 'request_changes') return outcome('rejected', 'admin_rejected', chamberResults);
		return outcome('voting', 'still_open', chamberResults);
	},
};

export const simpleMajorityProvider: GovernanceVotingProvider = {
	id: 'simple_majority_v1',
	label: 'Simple majority',
	version: '1',
	describeRule(input) {
		const config = { quorumMode: 'active_electorate', quorumPercent: 0.2, supportThreshold: 0.5, rejectThreshold: 0.5, minimumParticipatingVoters: 3, allowDelegation: true, ...input.providerConfig };
		return { providerId: this.id, providerVersion: this.version, label: this.label, summary: 'One chamber passes by majority after quorum is met.', config };
	},
	snapshotElectorate(input) {
		const config = this.describeRule(input).config;
		const active = activeWeightFor('member_chamber', input.eligibleVoters);
		const eligible = eligibleWeightFor('member_chamber', input.eligibleVoters);
		const quorum = Math.max(numberConfig(config, 'minimumParticipatingVoters', 3), active * clampRatio(numberConfig(config, 'quorumPercent', 0.2)));
		return baseSnapshot(this, input, [{
			id: 'member_chamber',
			label: 'Member majority',
			kind: 'member_equal',
			eligibleWeightTotal: eligible,
			activeWeightTotal: active,
			quorumWeightRequired: Math.min(quorum, Math.max(active, eligible)),
			supportWeightRequired: 0,
			objectWeightRequired: 0,
		}]);
	},
	normalizeVote: standardVote,
	evaluate(input) {
		const [result] = evaluateChambers(input);
		const ended = votingEnded(input);
		if (result.quorumMet && ended && result.supportWeight > result.objectWeight) return outcome('accepted', 'support_threshold_met', [result]);
		if (result.quorumMet && ended && result.objectWeight >= result.supportWeight) return outcome('rejected', 'object_threshold_met', [result]);
		if (ended && !result.quorumMet) return outcome('no_decision_quorum_failed', 'deadline_quorum_failed', [result]);
		return outcome('voting', 'still_open', [result]);
	},
};

export const absoluteThresholdProvider: GovernanceVotingProvider = {
	id: 'absolute_threshold_v1',
	label: 'Absolute threshold',
	version: '1',
	describeRule(input) {
		const config = { quorumMode: 'active_electorate', quorumPercent: 0.2, acceptThreshold: 0.6, rejectThreshold: 0.6, minimumParticipatingVoters: 3, allowDelegation: true, ...input.providerConfig };
		return { providerId: this.id, providerVersion: this.version, label: this.label, summary: 'One chamber passes when support reaches a configured active-electorate threshold.', config };
	},
	snapshotElectorate(input) {
		const config = this.describeRule(input).config;
		const active = activeWeightFor('member_chamber', input.eligibleVoters);
		const eligible = eligibleWeightFor('member_chamber', input.eligibleVoters);
		return baseSnapshot(this, input, [{
			id: 'member_chamber',
			label: 'Member threshold',
			kind: 'member_equal',
			eligibleWeightTotal: eligible,
			activeWeightTotal: active,
			quorumWeightRequired: Math.min(Math.max(numberConfig(config, 'minimumParticipatingVoters', 3), active * clampRatio(numberConfig(config, 'quorumPercent', 0.2))), Math.max(active, eligible)),
			supportWeightRequired: active * clampRatio(numberConfig(config, 'acceptThreshold', 0.6)),
			objectWeightRequired: active * clampRatio(numberConfig(config, 'rejectThreshold', 0.6)),
		}]);
	},
	normalizeVote: standardVote,
	evaluate(input) {
		const [result] = evaluateChambers(input);
		if (result.status === 'accepted') return outcome('accepted', 'support_threshold_met', [result]);
		if (result.status === 'rejected') return outcome('rejected', 'object_threshold_met', [result]);
		if (votingEnded(input)) {
			if (!result.quorumMet) return outcome('no_decision_quorum_failed', 'deadline_quorum_failed', [result]);
			return outcome('rejected', 'deadline_support_failed', [result]);
		}
		return outcome('voting', 'still_open', [result]);
	},
};

export const BicameralProvider: GovernanceVotingProvider = {
	id: 'treeseed_bicameral_v1',
	label: 'TreeSeed bicameral',
	version: '1',
	describeRule(input) {
		const config = {
			quorumMode: 'active_electorate',
			activeWindowDays: 90,
			memberChamber: { quorumPercent: 0.2, supportThreshold: 0.5, rejectThreshold: 0.5, minimumParticipatingVoters: 3 },
			stakeChamber: { quorumPercent: 0.2, supportThreshold: 0.6, rejectThreshold: 0.6, minimumParticipatingVoters: 3 },
			allowDelegation: true,
			allowDirectVoteOverrideDelegation: true,
			deadlineOutcome: 'no_decision_quorum_failed',
			...input.providerConfig,
		};
		return { providerId: this.id, providerVersion: this.version, label: this.label, summary: 'Member equality and weighted stake chambers must both approve.', config };
	},
	snapshotElectorate(input) {
		const config = this.describeRule(input).config;
		const member = chamberConfig(config, 'memberChamber', { quorumPercent: 0.2, supportThreshold: 0.5, rejectThreshold: 0.5, minimumParticipatingVoters: 3 });
		const stake = chamberConfig(config, 'stakeChamber', { quorumPercent: 0.2, supportThreshold: 0.6, rejectThreshold: 0.6, minimumParticipatingVoters: 3 });
		const memberActive = activeWeightFor('member_chamber', input.eligibleVoters);
		const memberEligible = eligibleWeightFor('member_chamber', input.eligibleVoters);
		const stakeActive = activeWeightFor('stake_chamber', input.eligibleVoters);
		const stakeEligible = eligibleWeightFor('stake_chamber', input.eligibleVoters);
		return baseSnapshot(this, input, [
			{
				id: 'member_chamber',
				label: 'Member chamber',
				kind: 'member_equal',
				eligibleWeightTotal: memberEligible,
				activeWeightTotal: memberActive,
				quorumWeightRequired: Math.min(Math.max(numberConfig(member, 'minimumParticipatingVoters', 3), memberActive * clampRatio(numberConfig(member, 'quorumPercent', 0.2))), Math.max(memberActive, memberEligible)),
				supportWeightRequired: memberActive * clampRatio(numberConfig(member, 'supportThreshold', 0.5)),
				objectWeightRequired: memberActive * clampRatio(numberConfig(member, 'rejectThreshold', 0.5)),
			},
			{
				id: 'stake_chamber',
				label: 'Stake chamber',
				kind: 'stake_weighted',
				eligibleWeightTotal: stakeEligible,
				activeWeightTotal: stakeActive,
				quorumWeightRequired: Math.min(Math.max(numberConfig(stake, 'minimumParticipatingVoters', 3), stakeActive * clampRatio(numberConfig(stake, 'quorumPercent', 0.2))), Math.max(stakeActive, stakeEligible)),
				supportWeightRequired: stakeActive * clampRatio(numberConfig(stake, 'supportThreshold', 0.6)),
				objectWeightRequired: stakeActive * clampRatio(numberConfig(stake, 'rejectThreshold', 0.6)),
			},
		]);
	},
	normalizeVote: standardVote,
	evaluate(input) {
		const results = evaluateChambers(input);
		if (results.every((result) => result.status === 'accepted')) return outcome('accepted', 'support_threshold_met', results);
		if (results.some((result) => result.status === 'rejected')) return outcome('rejected', 'object_threshold_met', results);
		if (votingEnded(input)) {
			if (results.some((result) => !result.quorumMet)) return outcome('no_decision_quorum_failed', 'deadline_quorum_failed', results);
			return outcome('rejected', 'deadline_support_failed', results);
		}
		return outcome('voting', 'still_open', results);
	},
};

export const governanceVotingProviders: Record<string, GovernanceVotingProvider> = {
	[adminApprovalProvider.id]: adminApprovalProvider,
	[simpleMajorityProvider.id]: simpleMajorityProvider,
	[absoluteThresholdProvider.id]: absoluteThresholdProvider,
	[BicameralProvider.id]: BicameralProvider,
};

export function governanceVotingProvider(id: string | null | undefined): GovernanceVotingProvider {
	return governanceVotingProviders[id ?? ''] ?? adminApprovalProvider;
}
