import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { relationAuthoringDatabase } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { validateDecisionAuthority, type DecisionAuthorityDatabase } from '../../../../../../src/api/governance/decision-authority.ts';
import { proposalNativeFixture } from './proposal-native-fixture.ts';
import { readyProposal } from './ready-proposal-fixture.ts';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';

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
	it('native governance evaluation retains interrupted electorate history and rejects absent readback before a fresh unchanged retry can close the proposal', async () => {
		const f = await relationAuthoringDatabase(true);
		try {
			const id = `electorate-${randomUUID()}`, input = { adminDecision: 'rejected', expectedProposalVersion: 1,
				actorType: 'user', actorId: f.principal.id }, heldInput = structuredClone(input);
			const proposal = await f.store.createGovernanceProposal(f.principal, { id, teamId: 'team', projectId: f.sources[0]!.projectId,
				title: 'Controlled electorate interruption', request: 'Do not create execution authority from missing electorate readback.', status: 'open' });
			expect(proposal?.status).toBe('open');
			await f.db.exec(`CREATE FUNCTION erase_native_electorate_readback() RETURNS trigger AS $$ BEGIN
				DELETE FROM governance_electorate_snapshots WHERE id=NEW.id; RETURN NEW; END; $$ LANGUAGE plpgsql;
				CREATE TRIGGER erase_native_electorate_readback AFTER INSERT ON governance_electorate_snapshots
				FOR EACH ROW EXECUTE FUNCTION erase_native_electorate_readback();`);
			const before = await f.snapshot(), retained = await f.store.getGovernanceProposal(id);
			for (const result of await Promise.allSettled([f.store.evaluateGovernanceProposal(id, input), f.peerStore!.evaluateGovernanceProposal(id, input)])) {
				expect(result.status).toBe('rejected');
				if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409, code: 'governance_electorate_required' });
			}
			await expect(f.store.evaluateGovernanceProposal(id, input)).rejects.toMatchObject({ status: 409, code: 'governance_electorate_required' });
			expect(await f.store.getGovernanceProposal(id)).toEqual(retained); expect(await f.snapshot()).toEqual(before);
			expect(await f.store.all('SELECT * FROM governance_electorate_snapshots WHERE proposal_id=?', [id])).toEqual([]);
			expect(await f.store.all('SELECT * FROM governance_decisions WHERE proposal_id=?', [id])).toEqual([]);
			const events = await f.store.all('SELECT * FROM governance_events WHERE proposal_id=? ORDER BY id', [id]);
			expect(events.filter(event => event.event_type === 'governance.electorate_snapshotted')).toHaveLength(3);
			await f.db.exec('DROP TRIGGER erase_native_electorate_readback ON governance_electorate_snapshots; DROP FUNCTION erase_native_electorate_readback();');
			const outcome = await f.store.evaluateGovernanceProposal(id, input);
			expect(outcome).toMatchObject({ status: 'rejected', outcome: { status: 'rejected' } });
			expect((await f.store.all('SELECT * FROM governance_events WHERE proposal_id=? ORDER BY id', [id]))
				.filter(event => events.some(prior => prior.id === event.id))).toEqual(events);
			expect(await f.store.all('SELECT * FROM governance_electorate_snapshots WHERE proposal_id=?', [id])).toHaveLength(1);
			expect(await f.store.all('SELECT * FROM governance_decisions WHERE proposal_id=?', [id])).toEqual([]);
			expect(input).toEqual(heldInput);
		} finally { await f.close(); }
	});
	it('native electorate snapshot rejects each retained invalid proposal scope before policy or electorate writes through concurrent denial and exact retry', async () => {
		const fixture = await proposalNativeFixture(), writes: string[] = [];
		const store = new ControlPlaneStore(fixture.store.config, { prepare: (sql: string) => ({ bind: (...parameters: unknown[]) => ({
			first: async () => (await fixture.query(sql, parameters)).rows[0] ?? null,
			all: async () => ({ results: (await fixture.query(sql, parameters)).rows }),
			run: async () => { writes.push(sql); return fixture.query(sql, parameters); },
		}) }) });
		store.initializationPromise = Promise.resolve();
		try {
			await fixture.publish(readyProposal());
			for (const scope of ['', ' ', ' project', 'project ', 'TEAM', 'unknown']) {
				await fixture.query("UPDATE governance_proposals SET scope=? WHERE id='proposal'", [scope]);
				const before = await fixture.snapshot(), proposal = await store.getGovernanceProposal('proposal');
				expect(proposal?.scope).toBe(scope);
				for (const result of await Promise.allSettled([store.snapshotGovernanceElectorate('proposal'), store.snapshotGovernanceElectorate('proposal')])) {
					expect(result.status).toBe('rejected');
					if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409, code: 'governance_proposal_scope_invalid' });
				}
				await expect(store.snapshotGovernanceElectorate('proposal')).rejects.toMatchObject({ status: 409, code: 'governance_proposal_scope_invalid' });
				expect(await fixture.snapshot()).toEqual(before); expect(writes).toEqual([]); expect(fixture.requests).toEqual([]);
			}
		} finally { await fixture.close(); }
	});
	it('owning native proposal evaluation denies incomplete plans and exact unresolved feedback before electorate or decision writes without rewriting retained history', async () => {
		for (const scenario of ['plan', 'blocker']) {
			const fixture = await proposalNativeFixture(), writes: string[] = [];
			const store = new ControlPlaneStore(fixture.store.config, {
				prepare: (sql: string) => ({ bind: (...parameters: unknown[]) => ({
					first: async () => (await fixture.query(sql, parameters)).rows[0] ?? null,
					all: async () => ({ results: (await fixture.query(sql, parameters)).rows }),
					run: async () => { writes.push(sql); return fixture.query(sql, parameters); },
				}) }),
				batch: async () => { writes.push('batch'); throw new Error('Denied evaluation must not write a batch'); },
			} satisfies ControlPlaneStore['db']);
			store.initializationPromise = Promise.resolve();
			// The bound library is a supplied input; SQL, exact native Git bytes,
			// official HTTP reads, readiness and evaluation are the original owners.
			Object.assign(store, { getProjectTreeDxLibrary: fixture.store.getProjectTreeDxLibrary });
			try {
				const declaration = readyProposal();
				if (scenario === 'plan') Object.assign(declaration.executionPlan.workItems[0]!, { estimate: undefined });
				const supplied = structuredClone(declaration), source = await fixture.publish(declaration);
				await fixture.query("UPDATE governance_proposals SET status='open' WHERE id='proposal'");
				if (scenario === 'blocker') {
					const proposalRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
						digest: `sha256:${source.digest}`, repository: 'repository', commit: source.commit, path: 'proposals/proposal.mdx' };
					const decision = { schemaVersion: 'treeseed.decision/v1', id: 'blocking-feedback', projectId: 'project',
						decisionClass: 'proposal', decisionMethod: 'authority', subjectRef: proposalRef, disposition: 'rejected',
						rationale: 'Controlled exact unresolved feedback, not an actual provider review.', authorityRefs: [proposalRef],
						decidedByRefs: [{ store: 'postgresql', model: 'user', id: 'operator', revision: 1, digest: `sha256:${'a'.repeat(64)}` }],
						decidedAt: '2026-10-02T21:00:01.000Z' };
					expect(validatePortableContentData('decision', decision).ok).toBe(true);
					const path = 'decisions/blocking-feedback.mdx', feedback = fixture.publishContent(path, decision);
					const decisionRef = { store: 'treedx', model: 'decision', id: decision.id, revision: 1,
						digest: `sha256:${feedback.digest}`, repository: 'repository', commit: feedback.commit, path };
					await fixture.query(`INSERT INTO governance_events (id,event_type,team_id,project_id,proposal_id,message,evidence_json,created_at)
						VALUES ('feedback','proposal.discussion','team','project','proposal',?,?,?)`,
						[decision.rationale, JSON.stringify({ kind: 'concern', decisionRef, contentPath: path, commitSha: feedback.commit,
							digest: decisionRef.digest, proposalVersion: 1 }), decision.decidedAt]);
				}
				const input = { expectedProposalVersion: 1, actorType: 'user', actorId: 'operator' }, held = structuredClone(input);
				const before = await fixture.snapshot(), readiness = await store.governanceProposalReadiness('proposal');
				expect(readiness, JSON.stringify({ scenario, readiness })).toMatchObject({ votingReady: false, executionPlanReady: scenario === 'blocker',
					unresolvedBlockerCount: scenario === 'blocker' ? 1 : 0 });
				for (const outcome of await Promise.allSettled([store.evaluateGovernanceProposal('proposal', input),
					store.evaluateGovernanceProposal('proposal', input)])) {
					expect(outcome.status).toBe('rejected');
					if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ status: 409, code: 'governance_proposal_not_ready' });
				}
				await expect(store.evaluateGovernanceProposal('proposal', input)).rejects.toMatchObject({ status: 409, code: 'governance_proposal_not_ready' });
				expect(writes).toEqual([]); expect(await fixture.snapshot()).toEqual(before);
				expect(input).toEqual(held); expect(declaration).toEqual(supplied); expect(fixture.requests.length).toBeGreaterThan(0);
			} finally { await fixture.close(); }
		}
	});
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
