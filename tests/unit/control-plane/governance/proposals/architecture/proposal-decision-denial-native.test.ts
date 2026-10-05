import { describe, expect, it } from 'vitest';
import { validateDecisionAuthority, type DecisionAuthorityDatabase } from '../../../../../../src/api/governance/decision-authority.ts';
import { proposalNativeFixture } from './proposal-native-fixture.ts';
import { readyProposal } from './ready-proposal-fixture.ts';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';

async function operationalDecision() {
	const fixture = await proposalNativeFixture();
	try {
		const source = await fixture.publish(readyProposal());
		await fixture.query("UPDATE governance_proposals SET status='accepted',active_version=2 WHERE id='proposal'");
		const proposalRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 2, digest: `sha256:${source.digest}`,
			repository: 'repository', commit: source.commit, path: 'proposals/proposal.mdx' };
		await fixture.query(`INSERT INTO governance_decisions (id,team_id,project_id,proposal_id,proposal_version,proposal_content_hash,
			status,title,summary,governance_provider_id,decision_record_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			['decision', 'team', 'project', 'proposal', 2, source.digest, 'accepted', 'Operational fixture', 'No governed Decision was written.',
				'default', JSON.stringify({ proposalRef, decisionDependencies: [] }), '2026-10-02T12:00:00.000Z', '2026-10-02T12:00:00.000Z']);
		const resolve = () => validateDecisionAuthority(fixture.store as unknown as DecisionAuthorityDatabase, 'decision', { teamId: 'team', projectId: 'project' });
		return { ...fixture, resolve };
	} catch (error) { await fixture.close(); throw error; }
}

describe('native proposal Decision authority', () => {
	it('original decision creation replay denies retained foreign stale rejected and superseded SQL authority without rewriting history', async () => {
		const fixture = await operationalDecision(), writes: string[] = [];
		const store = new ControlPlaneStore(fixture.store.config, {
			prepare: (sql: string) => ({ bind: (...parameters: unknown[]) => ({
				first: async () => (await fixture.query(sql, parameters)).rows[0] ?? null,
				all: async () => (await fixture.query(sql, parameters)).rows,
				run: async () => { writes.push(sql); return fixture.query(sql, parameters); },
			}) }),
			batch: async () => { writes.push('batch'); throw new Error('Unexpected replay batch'); },
		});
		store.initializationPromise = Promise.resolve();
		try {
			const retained = await fixture.snapshot(), input = { actorType: 'user', actorId: 'operator' }, originalInput = structuredClone(input);
			const variants = [
				{ sql: "UPDATE governance_decisions SET team_id='foreign-team' WHERE id='decision'", code: 'governance_decision_team_mismatch' },
				{ sql: "UPDATE governance_decisions SET project_id='foreign-project' WHERE id='decision'", code: 'governance_decision_project_mismatch' },
				{ sql: "UPDATE governance_decisions SET status='rejected' WHERE id='decision'", code: 'governance_decision_not_accepted' },
				{ sql: "UPDATE governance_decisions SET superseded_at='2026-10-04T00:00:00.000Z' WHERE id='decision'", code: 'governance_decision_not_accepted' },
				{ sql: "UPDATE governance_proposals SET status='withdrawn' WHERE id='proposal'", code: 'governance_proposal_not_accepted' },
				{ sql: "UPDATE governance_proposals SET active_version=3 WHERE id='proposal'", code: 'governance_decision_proposal_stale' },
				{ sql: "UPDATE governance_proposals SET active_content_hash='moved' WHERE id='proposal'", code: 'governance_decision_proposal_stale' },
			];
			const originalProposal = (await fixture.query("SELECT active_content_hash FROM governance_proposals WHERE id='proposal'")).rows[0]!;
			for (const variant of variants) {
				await fixture.query(variant.sql); const before = await fixture.snapshot();
				for (let retry = 0; retry < 2; retry++) await expect(store.createGovernanceDecisionFromProposal('proposal', input))
					.rejects.toMatchObject({ status: 409, code: variant.code });
				expect(await fixture.snapshot()).toEqual(before); expect(writes).toEqual([]); expect(input).toEqual(originalInput);
				await fixture.query("UPDATE governance_decisions SET team_id='team',project_id='project',status='accepted',superseded_at=NULL WHERE id='decision'");
				await fixture.query("UPDATE governance_proposals SET status='accepted',active_version=2,active_content_hash=? WHERE id='proposal'", [originalProposal.active_content_hash]);
			}
			expect(await fixture.snapshot()).toEqual(retained);
		} finally { await fixture.close(); }
	});
	it('does not substitute an accepted SQL row and exact proposal bytes for a governed classed Decision', async () => {
		const fixture = await operationalDecision();
		try {
			const before = await fixture.snapshot();
			await expect(fixture.resolve()).resolves.toMatchObject({ valid: false });
			for (const value of await Promise.all([fixture.resolve(), fixture.resolve()])) expect(value.valid).toBe(false);
			expect(await fixture.snapshot()).toEqual(before);
		} finally { await fixture.close(); }
	});
	it('retains fail-closed moved proposal revision, digest and superseded Decision controls in owning SQL', async () => {
		const fixture = await operationalDecision();
		try {
			const original = (await fixture.query("SELECT active_content_hash FROM governance_proposals WHERE id='proposal'")).rows[0]!;
			for (const mutation of ["UPDATE governance_proposals SET active_version=3 WHERE id='proposal'",
				"UPDATE governance_proposals SET active_content_hash='moved' WHERE id='proposal'",
				"UPDATE governance_decisions SET superseded_at='2026-10-02T12:01:00.000Z' WHERE id='decision'"]) {
				await fixture.query(mutation); const before = await fixture.snapshot();
				await expect(fixture.resolve()).resolves.toMatchObject({ valid: false });
				expect(await fixture.snapshot()).toEqual(before);
				await fixture.query("UPDATE governance_proposals SET active_version=2,active_content_hash=? WHERE id='proposal'", [original.active_content_hash]);
				await fixture.query("UPDATE governance_decisions SET superseded_at=NULL WHERE id='decision'");
			}
		} finally { await fixture.close(); }
	});
});
