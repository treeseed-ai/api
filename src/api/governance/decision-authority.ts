import { normalizeDecisionDependencyReferences,type DecisionAuthoritySnapshot,type DecisionAuthorityValidation,type DecisionDependencyReference,type DecisionDependencySnapshot } from '@treeseed/sdk';

type Row = Record<string, unknown>;
export interface DecisionAuthorityDatabase {
	first<T extends Row = Row>(query: string, params?: unknown[]): Promise<T | null>;
}

function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function number(value: unknown) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : 0; }
function object(value: unknown): Row {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value !== 'string') return {};
	try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {}; } catch { return {}; }
}

async function decisionRow(database: DecisionAuthorityDatabase, decisionId: string) {
	return database.first(`SELECT decision.id, decision.team_id, decision.project_id, decision.proposal_id,
		decision.proposal_version, decision.proposal_content_hash, decision.status, decision.superseded_at,
		decision.decision_record_json, proposal.status AS proposal_status, proposal.active_version,
		proposal.active_content_hash
		FROM governance_decisions decision
		LEFT JOIN governance_proposals proposal ON proposal.id = decision.proposal_id
		WHERE decision.id = ? LIMIT 1`, [decisionId]);
}

function snapshot(row: Row, dependencies: DecisionDependencySnapshot[]): DecisionAuthoritySnapshot {
	return {
		teamId: text(row.team_id), projectId: text(row.project_id), decisionId: text(row.id),
		proposalId: text(row.proposal_id), proposalVersion: number(row.proposal_version),
		proposalContentHash: text(row.proposal_content_hash), decisionDependencies: dependencies,
	};
}

function rowProblem(row: Row | null, expected?: { teamId?: string; projectId?: string }) {
	if (!row) return { code: 'governance_decision_missing', message: 'The governance decision does not exist.' };
	if (expected?.teamId && text(row.team_id) !== expected.teamId) return { code: 'governance_decision_team_mismatch', message: 'The governance decision belongs to another team.' };
	if (expected?.projectId && text(row.project_id) !== expected.projectId) return { code: 'governance_decision_project_mismatch', message: 'The governance decision belongs to another project.' };
	if (text(row.status) !== 'accepted' || row.superseded_at) return { code: 'governance_decision_not_accepted', message: 'The governance decision is no longer accepted and current.' };
	if (text(row.proposal_status) !== 'accepted') return { code: 'governance_proposal_not_accepted', message: 'The source proposal is no longer accepted.' };
	if (number(row.active_version) !== number(row.proposal_version) || text(row.active_content_hash) !== text(row.proposal_content_hash)) {
		return { code: 'governance_decision_proposal_stale', message: 'The accepted decision no longer matches the current source proposal revision.' };
	}
	return null;
}

function recordedDependencies(row: Row) {
	return object(row.decision_record_json).decisionDependencies;
}

export async function resolveDecisionDependencySnapshots(
	database: DecisionAuthorityDatabase,
	teamId: string,
	references: DecisionDependencyReference[],
) {
	const resolved: DecisionDependencySnapshot[] = [];
	for (const reference of normalizeDecisionDependencyReferences(references)) {
		const validation = await validateDecisionAuthority(database, reference.decisionId, { teamId, projectId: reference.projectId });
		if (!validation.valid || !validation.current) return { ok: false as const, reference, validation };
		const { decisionDependencies: _nested, ...dependency } = validation.current;
		resolved.push(dependency);
	}
	return { ok: true as const, dependencies: resolved };
}

export async function validateDecisionAuthority(
	database: DecisionAuthorityDatabase,
	decisionId: string,
	expected: { teamId?: string; projectId?: string } = {},
	ancestors: Set<string> = new Set(),
): Promise<DecisionAuthorityValidation> {
	if (!decisionId || ancestors.has(decisionId)) return { valid: false, code: 'governance_decision_dependency_cycle', message: 'The governance decision dependency graph contains a cycle.', current: null };
	const row = await decisionRow(database, decisionId);
	const problem = rowProblem(row, expected);
	if (problem || !row) return { valid: false, code: problem!.code, message: problem!.message, current: null };
	const nextAncestors = new Set(ancestors).add(decisionId);
	const recorded = recordedDependencies(row);
	const references = normalizeDecisionDependencyReferences(recorded);
	if ((Array.isArray(recorded) && recorded.length !== references.length)) return { valid: false, code: 'governance_decision_dependency_snapshot_invalid', message: 'The governance decision contains an invalid dependency snapshot.', current: null };
	const dependencies: DecisionDependencySnapshot[] = [];
	for (const reference of references) {
		const dependency = await validateDecisionAuthority(database, reference.decisionId, { teamId: text(row.team_id), projectId: reference.projectId }, nextAncestors);
		if (!dependency.valid || !dependency.current) return { valid: false, code: dependency.code, message: dependency.message, current: null };
		const expectedSnapshot = (recorded as unknown[]).map(object).find((entry) => text(entry.decisionId) === reference.decisionId && text(entry.projectId) === reference.projectId);
		const { decisionDependencies: _nested, ...currentSnapshot } = dependency.current;
		if (!expectedSnapshot || text(expectedSnapshot.teamId) !== currentSnapshot.teamId || text(expectedSnapshot.proposalId) !== currentSnapshot.proposalId
			|| number(expectedSnapshot.proposalVersion) !== currentSnapshot.proposalVersion || text(expectedSnapshot.proposalContentHash) !== currentSnapshot.proposalContentHash) {
			return { valid: false, code: 'governance_decision_dependency_stale', message: `Dependency ${reference.decisionId} no longer matches its accepted snapshot.`, current: null };
		}
		dependencies.push(currentSnapshot);
	}
	return { valid: true, code: null, message: null, current: snapshot(row, dependencies) };
}

export async function validateExecutionAuthorityReceipt(database: DecisionAuthorityDatabase, receiptValue: unknown): Promise<DecisionAuthorityValidation> {
	const receipt = object(receiptValue);
	const decisionId = text(receipt.decisionId);
	const projectId = text(receipt.projectId);
	const teamId = text(receipt.teamId);
	const current = await validateDecisionAuthority(database, decisionId, { ...(teamId ? { teamId } : {}), projectId });
	if (!current.valid || !current.current) return current;
	if (text(receipt.proposalId) !== current.current.proposalId || number(receipt.proposalVersion) !== current.current.proposalVersion
		|| text(receipt.proposalContentHash) !== current.current.proposalContentHash) {
		return { valid: false, code: 'governance_execution_authority_stale', message: 'The execution authority does not match the current accepted proposal revision.', current: current.current };
	}
	const expectedDependencies = normalizeDecisionDependencyReferences(receipt.decisionDependencies);
	const currentDependencies = current.current.decisionDependencies.map(({ projectId: dependencyProjectId,decisionId: dependencyDecisionId }) => ({ projectId: dependencyProjectId, decisionId: dependencyDecisionId }));
	if (JSON.stringify(expectedDependencies) !== JSON.stringify(currentDependencies)) {
		return { valid: false, code: 'governance_execution_dependencies_stale', message: 'The execution authority dependency set does not match the accepted decision.', current: current.current };
	}
	return current;
}
