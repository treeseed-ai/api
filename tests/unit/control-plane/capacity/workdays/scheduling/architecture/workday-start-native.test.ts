import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appliedWorkdaySchema, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { canonicalJson } from '../../../../../../../src/api/capacity/security.ts';
import { workdayStartDatabase } from './workday-start-fixture.ts';

// AUTHORING ONLY: no execution receipt. Native SQL/HTTP controls do not prove
// separate PostgreSQL connections, actual TreeDX policy or provider consumption.
describe('first manual and recurring admission through the same public owning path', () => {
	it('real public workday policy reads and preflight deny every missing stored policy field without inserting defaults or admission truth', async () => {
		const f = await workdayStartDatabase(); try {
			const original = { revision: 1, policy: structuredClone(DEFAULT_WORKDAY_POLICY) }, intent = structuredClone(f.intent);
			await f.query('UPDATE teams SET metadata_json=? WHERE id=?', [JSON.stringify({ workdayProfile: original }), 'team']);
			expect(await f.publicService.profilesShow(f.principal, 'team', 'default')).toEqual({ id: 'default', teamId: 'team', ...original });
			const admitted: string[] = [];
			for (const field of Object.keys(original.policy)) {
				const policy = Object.fromEntries(Object.entries(original.policy).filter(([key]) => key !== field));
				const bytes = JSON.stringify({ workdayProfile: { revision: 1, policy } });
				await f.query('UPDATE teams SET metadata_json=? WHERE id=?', [bytes, 'team']);
				const before = await f.snapshot(), calls = structuredClone(f.calls);
				for (const [kind, operation] of [['show', () => f.publicService.profilesShow(f.principal, 'team', 'default')],
					['preflight', () => f.preflight()]] as const) {
					try { await operation(); admitted.push(`${field}:${kind}`); }
					catch (error) { expect(error).toMatchObject({ status: 503, code: 'workday_profile_invalid' }); }
					expect(await f.snapshot()).toEqual(before); expect(f.calls).toEqual(calls);
					expect(await f.first('SELECT metadata_json FROM teams WHERE id=?', ['team'])).toEqual({ metadata_json: bytes });
				}
			}
			expect(admitted).toEqual([]); expect(f.intent).toEqual(intent); expect(original.policy).toEqual(DEFAULT_WORKDAY_POLICY);
			await f.query('UPDATE teams SET metadata_json=? WHERE id=?', [JSON.stringify({ workdayProfile: original }), 'team']);
			const planned = await f.preflight(); expect(planned.selectedDemands).toEqual([]);
			const after = await f.snapshot(); expect(after.receipts).toHaveLength(1); expect(after.workdays).toEqual([]);
			expect(after.assignments).toEqual([]); expect(after.reservations).toEqual([]); expect(after.usage).toEqual([]); expect(after.ledger).toEqual([]);
		} finally { await f.close(); }
	});
	it('native original planning ticks retain an interrupted generation and repeat beyond two rounds without duplicate nodes events or financial writes', async () => {
		const f = await workdayStartDatabase(); try {
			const input = structuredClone(f.intent), current = await f.publicService.profilesShow(f.principal, 'team', 'default');
			// A fresh test-owned policy BEFORE admission, not an extension of an
			// admitted deadline. Node states and tick clocks below are INPUTS;
			// no model, published contribution or measured usage is fabricated.
			const policy = { ...current.policy, durationSeconds: input.durationSeconds, planningPercent: 100,
				planningTurnMaximumSeconds: 10, maximumConcurrency: 1 };
			await f.publicService.profilesUpdate(f.principal, 'team', 'default', { policy }, String(current.revision));
			const planned = await f.preflight(), receipt = await f.start(planned);
			const initial = await f.store.getCapacityWorkdayRun('team', receipt.workdayId);
			if (!initial) throw new Error('Original native started run required');
			const originalPlan = appliedWorkdaySchema.parse(initial.parameters.appliedPlan), initialTruth = await f.snapshot();
			expect(originalPlan.policySnapshot).toEqual(policy); expect(originalPlan.planningRounds).toHaveLength(1);
			const nativePlan = async () => {
				const run = await f.store.getCapacityWorkdayRun('team', receipt.workdayId);
				if (!run) throw new Error('Original native run missing after tick');
				return appliedWorkdaySchema.parse(run.parameters.appliedPlan);
			};
			for (const ordinal of [2, 3, 4]) {
				const beforePlan = await nativePlan(), prior = beforePlan.planningRounds.at(-1)!;
				const now = new Date(Date.parse(originalPlan.startsAt) + (ordinal - 1) * 10_000).toISOString();
				for (const id of prior.assignmentIds) await f.query("UPDATE execution_nodes SET status='completed',updated_at=? WHERE team_id=? AND id=?", [now, 'team', id]);
				const key = `native-planning-round-${ordinal}`;
				if (ordinal === 2) {
					// Failure occurs AFTER original plan/graph writes but BEFORE the
					// tick receipt. Retain that real partial state; do not claim a
					// whole-workflow rollback or erase it to make retry pass.
					await f.db.exec(`CREATE FUNCTION planning_tick_failure() RETURNS trigger LANGUAGE plpgsql AS $$
						BEGIN IF NEW.event_type='workday.tick' THEN RAISE EXCEPTION 'allocated tick failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
						CREATE TRIGGER planning_tick_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION planning_tick_failure();`);
					await expect(f.store.tickCapacityWorkdayRun('team', receipt.workdayId, now, key)).rejects.toMatchObject({ code: 'P0001' });
					const interrupted = await f.snapshot(), interruptedPlan = await nativePlan();
					expect(interruptedPlan.planningRounds).toHaveLength(ordinal);
					expect(interrupted.events).toEqual(initialTruth.events);
					expect(interrupted.assignments).toEqual([]); expect(interrupted.reservations).toEqual([]);
					expect(interrupted.usage).toEqual([]); expect(interrupted.ledger).toEqual([]);
					await f.db.exec('DROP TRIGGER planning_tick_failure ON capacity_workday_events; DROP FUNCTION planning_tick_failure();');
					expect(await f.all("SELECT tgname FROM pg_trigger WHERE tgname='planning_tick_failure'")).toEqual([]);
					expect(await f.all("SELECT proname FROM pg_proc WHERE proname='planning_tick_failure'")).toEqual([]);
					expect(await f.snapshot()).toEqual(interrupted);
				}
				const tick = await f.store.tickCapacityWorkdayRun('team', receipt.workdayId, now, key), held = await f.snapshot();
				const next = await nativePlan();
				expect(next.planningRounds.map(round => round.round)).toEqual(Array.from({ length: ordinal }, (_, index) => index + 1));
				expect(next.planningRounds.slice(0, -1).every(round => round.state === 'complete')).toBe(true);
				expect(next.planningRounds.at(-1)).toMatchObject({ round: ordinal, state: 'active', startedAt: now });
				expect(next.startsAt).toBe(originalPlan.startsAt); expect(next.endsAt).toBe(originalPlan.endsAt);
				expect(next.policyRevision).toBe(originalPlan.policyRevision); expect(next.policySnapshot).toEqual(originalPlan.policySnapshot);
				const ids = next.planningRounds.flatMap(round => round.assignmentIds);
				expect(new Set(ids).size).toBe(ids.length); expect(held.nodes.map(node => node.id).sort()).toEqual([...ids].sort());
				const newest = next.planningRounds.at(-1)!;
				for (const id of newest.assignmentIds) {
					expect(held.nodes.find(node => node.id === id)).toMatchObject({ status: 'ready', kind: 'planning', workday_id: receipt.workdayId,
						project_id: 'project', agent_class: f.definition.agentClass });
					expect(held.edges.filter(edge => edge.to_node_id === id).map(edge => edge.from_node_id).sort()).toEqual([...prior.assignmentIds].sort());
				}
				expect(held.events.filter(event => event.event_type === 'workday.tick')).toHaveLength(ordinal - 1);
				expect(held.events.slice(0, initialTruth.events.length)).toEqual(initialTruth.events);
				expect(held.receipts).toEqual(initialTruth.receipts); expect(held.workdays).toHaveLength(1);
				expect(held.assignments).toEqual([]); expect(held.reservations).toEqual([]); expect(held.usage).toEqual([]); expect(held.ledger).toEqual([]);
				expect(await f.store.tickCapacityWorkdayRun('team', receipt.workdayId, now, key)).toEqual(tick);
				expect(await f.snapshot()).toEqual(held);
			}
			// Exact original tail: no whole turn fits. Expiry closes rather than
			// extending the deadline or publishing an empty success/report.
			const last = (await nativePlan()).planningRounds.at(-1)!;
			for (const id of last.assignmentIds) await f.query("UPDATE execution_nodes SET status='completed' WHERE team_id=? AND id=?", ['team', id]);
			const tail = new Date(Date.parse(originalPlan.endsAt) - 9_999).toISOString();
			await f.store.tickCapacityWorkdayRun('team', receipt.workdayId, tail, 'native-planning-tail');
			expect((await nativePlan()).planningRounds).toHaveLength(4);
			await f.store.tickCapacityWorkdayRun('team', receipt.workdayId, originalPlan.endsAt, 'native-planning-expiry');
			expect(await nativePlan()).toMatchObject({ state: 'closing', endsAt: originalPlan.endsAt, planningRounds: expect.arrayContaining([expect.objectContaining({ round: 4 })]) });
			expect((await nativePlan()).planningRounds).toHaveLength(4); expect(f.intent).toEqual(input);
			const final = await f.snapshot(); expect(final.usage).toEqual([]); expect(final.ledger).toEqual([]);
		} finally { await f.close(); }
	});
	it('real public preflight refuses missing unaccepted foreign superseded and stale selected native governance rows without persisting a receipt or broadening planning authority', async () => {
		const f = await workdayStartDatabase(); try {
			// All rows below are deliberate invalid authority INPUTS. None is a
			// genuine accepted Decision, native governance transition or positive
			// TreeDX content proof; no phantom-selector positive is introduced.
			const variants = [
				{ id: 'missing-decision', absent: true, code: 'governance_decision_missing' },
				{ id: 'decision-creating', status: 'creating', code: 'governance_decision_not_accepted' },
				{ id: 'decision-rejected', status: 'rejected', code: 'governance_decision_not_accepted' },
				{ id: 'decision-superseded', supersededAt: f.intent.startsAt, code: 'governance_decision_not_accepted' },
				{ id: 'decision-foreign-team', teamId: 'foreign-team', code: 'governance_decision_team_mismatch' },
				{ id: 'decision-foreign-project', projectId: 'foreign-project', code: 'governance_decision_project_mismatch' },
				{ id: 'decision-open-proposal', proposalStatus: 'open', code: 'governance_proposal_not_accepted' },
				{ id: 'decision-moved-version', activeVersion: 3, code: 'governance_decision_proposal_stale' },
				{ id: 'decision-moved-digest', activeDigest: 'b'.repeat(64), code: 'governance_decision_proposal_stale' },
				{ id: 'decision-missing-provenance', record: '{}', code: 'governance_decision_proposal_ref_invalid' },
				{ id: 'decision-malformed-provenance', record: '{invalid', code: 'governance_decision_proposal_ref_invalid' },
			];
			for (const variant of variants) {
				if (variant.absent) continue;
				const proposalId = `proposal-${variant.id}`, digest = 'a'.repeat(64);
				const proposalRef = { store: 'treedx', model: 'proposal', id: proposalId, revision: 2,
					digest: `sha256:${digest}`, repository: 'planning-library', commit: 'a'.repeat(40), path: `proposals/${proposalId}.mdx` };
				await f.query(`INSERT INTO governance_proposals (id,team_id,project_id,status,title,summary,body,active_version,
					active_content_hash,governance_provider_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
					[proposalId, variant.teamId ?? 'team', variant.projectId ?? 'project', variant.proposalStatus ?? 'accepted',
						'Invalid selection input', 'No governed acceptance supplied', 'No native content supplied', variant.activeVersion ?? 2,
						variant.activeDigest ?? digest, 'default', f.intent.startsAt, f.intent.startsAt]);
				await f.query(`INSERT INTO governance_decisions (id,team_id,project_id,proposal_id,proposal_version,proposal_content_hash,
					status,title,summary,governance_provider_id,decision_record_json,created_at,updated_at,superseded_at)
					VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [variant.id, variant.teamId ?? 'team', variant.projectId ?? 'project', proposalId,
						2, digest, variant.status ?? 'accepted', 'Invalid selection input', 'Not a genuine accepted Decision', 'default',
						variant.record ?? JSON.stringify({ proposalRef, decisionDependencies: [] }), f.intent.startsAt, f.intent.startsAt,
						variant.supersededAt ?? null]);
			}
			const observe = async () => ({ workday: await f.snapshot(),
				proposals: await f.all('SELECT * FROM governance_proposals ORDER BY id'),
				decisions: await f.all('SELECT * FROM governance_decisions ORDER BY id'),
				governanceEvents: await f.all('SELECT * FROM governance_events ORDER BY id') });
			const before = await observe(), original = structuredClone(f.intent);
			for (const variant of variants) {
				for (const executionMode of ['simulation', 'production']) {
					for (const planningOnly of [false, true]) {
						const body = { ...f.intent, executionMode, planningOnly, decisionIds: [variant.id] };
						const supplied = structuredClone(body);
						await expect(f.publicService.preflight(f.principal, 'team', body)).rejects.toMatchObject({ status: 409, code: variant.code });
						expect(await observe()).toEqual(before); expect(f.calls).toEqual([]); expect(body).toEqual(supplied);
					}
				}
			}
			// Repeated and overlapping requests must retain the SAME denial and
			// original invalid observations, not silently settle an empty selection.
			const repeated = { ...f.intent, decisionIds: ['missing-decision', 'missing-second'] }, supplied = structuredClone(repeated);
			const outcomes = await Promise.allSettled([
				f.publicService.preflight(f.principal, 'team', repeated), f.publicService.preflight(f.principal, 'team', repeated),
			]);
			for (const outcome of outcomes) {
				expect(outcome.status).toBe('rejected');
				if (outcome.status !== 'rejected') throw new Error('Missing decision selection was admitted');
				expect(outcome.reason).toMatchObject({ status: 409, code: 'governance_decision_missing' });
			}
			expect(await observe()).toEqual(before); expect(f.calls).toEqual([]); expect(repeated).toEqual(supplied); expect(f.intent).toEqual(original);
			const planned = await f.preflight(), after = await observe();
			expect(after.proposals).toEqual(before.proposals); expect(after.decisions).toEqual(before.decisions);
			expect(after.governanceEvents).toEqual(before.governanceEvents); expect(after.workday.receipts).toHaveLength(1);
			expect(after.workday.receipts[0]).toMatchObject({ operation: 'workday.preflight', resource_id: planned.id });
			const { receipts: ignored, ...truth } = after.workday, { receipts: prior, ...oldTruth } = before.workday;
			expect(prior).toEqual([]); expect(ignored).toHaveLength(1); expect(truth).toEqual(oldTruth); expect(f.calls).toEqual([]);
		} finally { await f.close(); }
	});
	it('real public preflight and nested schedule deny mixed malformed decision selectors and caller derived identities without native scheduling or financial writes', async () => {
		const f = await workdayStartDatabase(); try {
			const baseline = await f.snapshot(), original = structuredClone(f.intent);
			const malformed = [[], [''], [' \t\n '], ['valid', ''], ['valid', ' '], ['valid', null], ['valid', 1],
				['valid', {}], ['valid', []], null, 'valid', Array.from({ length: 65 }, (_, index) => `decision-${index}`), ['x'.repeat(201)], ['é'], ['e\u0301'], ['\uE000'], ['\u{10000}'], ['decision?']];
			const inputs: Array<{ body: Record<string, unknown>; code: string }> = malformed.map(decisionIds => ({
				body: { ...f.intent, decisionIds }, code: 'workday_intent_invalid',
			}));
			for (const field of ['executionPlanId', 'capacityPlanId', 'executionInputId', 'demandSetId']) {
				for (const value of [undefined, null, '', 'invented', { id: 'invented' }]) inputs.push({
					body: { ...f.intent, [field]: value }, code: 'workday_intent_derived_fields_forbidden',
				});
			}
			for (const value of [0, -1, '1', null, true, NaN, Infinity, -Infinity]) {
				for (const allocation of [{ allocationWeight: value }, { projectPercentages: { project: value } },
					{ agentClassPercentages: { project: { 'boundary-planner': value } } }]) inputs.push({
					body: { ...f.intent, allocation }, code: 'workday_intent_invalid',
				});
			}
			for (const { body, code } of inputs) {
				const before = structuredClone(body);
				await expect(f.publicService.preflight(f.principal, 'team', body)).rejects.toMatchObject({ status: 400, code });
				expect(await f.snapshot()).toEqual(baseline); expect(f.calls).toEqual([]); expect(body).toEqual(before);
				const scheduled = { id: 'invalid-selection', intent: body, cadenceSeconds: 60, nextRunAt: f.intent.startsAt };
				const scheduledBefore = structuredClone(scheduled);
				await expect(f.publicService.createSchedule(f.principal, 'team', scheduled)).rejects.toMatchObject({ status: 400, code });
				expect(await f.snapshot()).toEqual(baseline); expect(f.calls).toEqual([]); expect(scheduled).toEqual(scheduledBefore);
			}
			expect(f.intent).toEqual(original);
			const planned = await f.preflight(), after = await f.snapshot();
			expect(after.receipts).toHaveLength(1); expect(after.receipts[0]).toMatchObject({ operation: 'workday.preflight', resource_id: planned.id });
			const { receipts: ignored, ...truth } = after, { receipts: ignoredBefore, ...prior } = baseline;
			expect(ignoredBefore).toEqual([]); expect(ignored).toHaveLength(1); expect(truth).toEqual(prior); expect(f.calls).toEqual([]);
		} finally { await f.close(); }
	});
	it('real persisted preflight binds exact intent and receipt hashes and refuses changed selection bytes before unchanged original start and replay', async () => {
		const f = await workdayStartDatabase(); try {
			const original = structuredClone(f.intent), planned = await f.preflight();
			const row = (await f.snapshot()).receipts[0];
			if (!row || typeof row.response_json !== 'string') throw new Error('Native stored preflight bytes required');
			const raw = row.response_json;
			const stored: { intent: typeof f.intent; receipt: typeof planned; runInput: Record<string, unknown> } = JSON.parse(raw);
			const expectedIntentBytes = JSON.stringify({ durationSeconds: original.durationSeconds, executionMode: original.executionMode,
				operatorConstraints: { maxConcurrency: 1, providerIds: ['provider'] }, planningOnly: true, profileId: original.profileId,
				projects: original.projects, schemaVersion: original.schemaVersion, startsAt: original.startsAt, teamId: original.teamId });
			const hash = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('base64url')}`;
			expect(stored.intent).toEqual(original); expect(canonicalJson(stored.intent)).toBe(expectedIntentBytes);
			expect(planned.intentDigest).toBe(hash(expectedIntentBytes)); expect(row.request_digest).toBe(planned.intentDigest);
			expect(stored.receipt).toEqual(planned);
			const { preflightDigest, ...payload } = planned;
			expect(preflightDigest).toBe(hash(canonicalJson(payload)));
			expect(planned.demandSetDigest).toBe(hash(canonicalJson({ selectedDemands: planned.selectedDemands, objectives: [], proposalIds: [], decisionIds: [] })));
			const changes = [
				{ ...stored, intent: { ...stored.intent, decisionIds: ['unbound-selection'] } },
				{ ...stored, intent: { ...stored.intent, decisionIds: [] } },
				{ ...stored, intent: { ...stored.intent, decisionIds: ['valid', null] } },
				{ ...stored, intent: { ...stored.intent, capacityPlanId: 'caller-derived' } },
				{ ...stored, receipt: { ...stored.receipt, intentDigest: `sha256:${'b'.repeat(43)}` } },
				{ ...stored, receipt: { ...stored.receipt, demandSetDigest: `sha256:${'c'.repeat(43)}` } },
			];
			for (const changed of changes) {
				const bytes = JSON.stringify(changed), supplied = structuredClone(changed);
				await f.query('UPDATE capacity_operation_receipts SET response_json=? WHERE id=?', [bytes, row.id]);
				const before = await f.snapshot();
				await expect(f.start(planned, 'exact-selection-retry')).rejects.toMatchObject({ status: 409, code: 'workday_preflight_integrity_invalid' });
				expect(await f.snapshot()).toEqual(before); expect(f.calls).toEqual([]); expect(changed).toEqual(supplied);
				expect((await f.snapshot()).receipts[0]?.response_json).toBe(bytes);
			}
			await f.query('UPDATE capacity_operation_receipts SET response_json=? WHERE id=?', [raw, row.id]);
			const started = await f.start(planned, 'exact-selection-retry'), after = await f.snapshot();
			expect(started).toMatchObject({ preflightId: planned.id, preflightDigest, acceptedExecutionNodeIds: [], assignmentIds: [], reservationIds: [] });
			expect(after.receipts.find(entry => entry.id === row.id)).toEqual(row);
			expect(after.workdays).toHaveLength(1); expect(after.events.map(entry => entry.event_type)).toEqual(['workday.started', 'assignment.polling_ready']);
			expect(after.assignments).toEqual([]); expect(after.reservations).toEqual([]); expect(after.usage).toEqual([]); expect(after.ledger).toEqual([]);
			expect(await f.start(planned, 'exact-selection-retry')).toEqual(started); expect(await f.snapshot()).toEqual(after);
			expect(f.calls).toHaveLength(1); expect(f.intent).toEqual(original);
		} finally { await f.close(); }
	});
	it('preflights exact governed intent without starting a workday or mutating graph assignment reservation or financial authority', async () => {
		const f = await workdayStartDatabase(); try {
			const input = structuredClone(f.intent), before = await f.snapshot(), receipt = await f.preflight(), after = await f.snapshot();
			expect(receipt).toMatchObject({ teamId: 'team', profileId: 'default', startsAt: input.startsAt, maxConcurrency: 1 });
			expect(receipt.endsAt).toBe(new Date(Date.parse(input.startsAt) + input.durationSeconds * 1000).toISOString());
			const { receipts, ...truth } = after; const { receipts: prior, ...oldTruth } = before;
			expect(truth).toEqual(oldTruth); expect(prior).toEqual([]); expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({ operation: 'workday.preflight', resource_id: receipt.id });
			expect(f.calls).toEqual([]); expect(f.intent).toEqual(input);
		} finally { await f.close(); }
	});
	it('starts one native planning graph with exact frozen YAML context mode and original clocks then replays without another event or charge', async () => {
		const f = await workdayStartDatabase(); try {
			const input = structuredClone(f.intent), planned = await f.preflight(), receipt = await f.start(planned);
			const run = await f.store.getCapacityWorkdayRun('team', receipt.workdayId); if (!run) throw new Error('Actual persisted run required');
			const plan = appliedWorkdaySchema.parse(run.parameters.appliedPlan), truth = await f.snapshot();
			expect(plan).toMatchObject({ id: receipt.workdayId, teamId: 'team', executionMode: input.executionMode,
				state: 'active', startsAt: planned.startsAt, endsAt: planned.endsAt, policySnapshot: { durationSeconds: input.durationSeconds, maximumConcurrency: 1 } });
			expect(run.executionMode).toBe(input.executionMode); expect(run.parameters.deadlineAt).toBe(planned.endsAt);
			expect(run.parameters.agentProfilesByProjectId).toMatchObject({ project: { agents: [{ definition: f.definition }] } });
			expect(run.parameters.workdayContextByProjectId).toMatchObject({ project: { repository: 'planning-library', commit: 'a'.repeat(40), path: 'README.md' } });
			expect(truth.workdays).toHaveLength(1); expect(truth.nodes.length).toBeGreaterThan(0);
			for (const node of truth.nodes) expect(node).toMatchObject({ team_id: 'team', project_id: 'project', workday_id: receipt.workdayId, kind: 'planning', agent_class: f.definition.agentClass });
			expect(truth.events.map(event => event.event_type)).toEqual(['workday.started', 'assignment.polling_ready']);
			expect(truth.assignments).toEqual([]); expect(truth.reservations).toEqual([]); expect(truth.usage).toEqual([]); expect(truth.ledger).toEqual([]);
			expect(f.calls).toEqual([{ method: 'POST', path: '/api/v1/repos/planning-library/paths/list',
				input: { ref: 'a'.repeat(40), paths: ['**'], kinds: ['blob'], limit: 1, allowProtected: true } }]);
			expect(await f.start(planned)).toEqual(receipt); expect(await f.snapshot()).toEqual(truth); expect(f.calls).toHaveLength(1); expect(f.intent).toEqual(input);
		} finally { await f.close(); }
	});
	it('denies absent principal foreign team missing digest and conflicting idempotent start without new scheduling or accounting truth', async () => {
		const f = await workdayStartDatabase(); try {
			const planned = await f.preflight(), request = { preflightId: planned.id, preflightDigest: planned.preflightDigest }, before = await f.snapshot();
			await expect(f.publicService.start(undefined, 'team', request, 'missing-principal')).rejects.toMatchObject({ status: 401 });
			await expect(f.publicService.start(f.principal, 'foreign-team', request, 'foreign')).rejects.toMatchObject({ status: 404 });
			await expect(f.publicService.start(f.principal, 'team', { ...request, preflightDigest: '' }, 'missing-digest')).rejects.toThrow();
			await expect(f.publicService.start(f.principal, 'team', { ...request, preflightDigest: `sha256:${'b'.repeat(64)}` }, 'wrong-digest')).rejects.toMatchObject({ code: 'workday_preflight_digest_mismatch' });
			expect(await f.snapshot()).toEqual(before); expect(f.calls).toEqual([]);
			await f.start(planned); const started = await f.snapshot();
			await expect(f.publicService.start(f.principal, 'team', { ...request, preflightId: 'different' }, 'first-start')).rejects.toMatchObject({ code: 'capacity_idempotency_key_conflict' });
			expect(await f.snapshot()).toEqual(started);
		} finally { await f.close(); }
	});
	it('rejects membership revocation and moved profile library or policy authority between preflight and start with immutable original receipts', async () => {
		const mutations = ['membership', 'profile', 'library', 'policy'] as const;
		const outcomes = [];
		for (const mutation of mutations) {
			const f = await workdayStartDatabase(); try {
				const planned = await f.preflight();
				if (mutation === 'membership') await f.query("UPDATE capacity_provider_team_memberships SET status='revoked' WHERE id='membership'");
				if (mutation === 'profile') await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',
					[JSON.stringify({ agents: [{ ...f.definition, activityProfiles: { planning: { ...f.definition.activityProfiles.planning, prompt: { system: 'Changed after preflight.' } } } }] }), 'class']);
				if (mutation === 'library') await f.query('UPDATE treedx_project_libraries SET content_repository_ref=?,metadata_json=? WHERE id=?', ['b'.repeat(40), JSON.stringify({ resolvedRef: 'b'.repeat(40) }), 'binding']);
				if (mutation === 'policy') await f.query(`UPDATE teams SET metadata_json=jsonb_build_object('workdayProfile',jsonb_build_object('revision',2,'policy',?::jsonb))::text WHERE id='team'`,
					[JSON.stringify((await f.publicService.profilesShow(f.principal, 'team', 'default')).policy)]);
				const before = await f.snapshot(); let admitted = false; try { await f.start(planned); admitted = true; } catch { /* Denial is inspected independently below. */ }
				outcomes.push({ mutation, admitted, unchanged: JSON.stringify(await f.snapshot()) === JSON.stringify(before), requests: f.calls.length });
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(mutations.map(mutation => ({ mutation, admitted: false, unchanged: true, requests: 0 })));
	});
	it('denies missing denied unavailable malformed and moved native content resolution without a successful start receipt or widened original window', async () => {
		const mutations = ['missing', 'denied', 'unavailable', 'malformed', 'moved'] as const, observations = [];
		for (const mutation of mutations) {
			const f = await workdayStartDatabase(); try {
				const planned = await f.preflight();
				if (mutation === 'missing') f.upstream.resolvedRef = '';
				if (mutation === 'denied') f.upstream.status = 403;
				if (mutation === 'unavailable') f.upstream.status = 503;
				if (mutation === 'malformed') f.upstream.malformed = true;
				if (mutation === 'moved') f.upstream.resolvedRef = 'b'.repeat(40);
				let admitted = false; try { await f.start(planned); admitted = true; } catch { /* All faults are collected before assertions. */ }
				const truth = await f.snapshot(); observations.push({ mutation, admitted,
					starts: truth.receipts.filter(row => row.operation === 'workday.start').length,
					active: truth.workdays.filter(row => row.status === 'running').length,
					assignments: truth.assignments.length, reservations: truth.reservations.length, ledger: truth.ledger.length });
				for (const run of truth.workdays) expect(JSON.parse(String(run.parameters_json)).deadlineAt).toBe(planned.endsAt);
			} finally { await f.close(); }
		}
		expect(observations).toEqual(mutations.map(mutation => ({ mutation, admitted: false, starts: 0, active: 0, assignments: 0, reservations: 0, ledger: 0 })));
	});
	it('retains a native started run after late receipt interruption and retries the same admission without duplicate graph events or financial mutation', async () => {
		const f = await workdayStartDatabase(); try {
			const planned = await f.preflight();
			await f.db.exec(`CREATE FUNCTION isolated_start_receipt_stop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.operation='workday.start' THEN RAISE EXCEPTION 'isolated start receipt interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER isolated_start_receipt_stop BEFORE INSERT ON capacity_operation_receipts FOR EACH ROW EXECUTE FUNCTION isolated_start_receipt_stop();`);
			await expect(f.start(planned)).rejects.toThrow('isolated start receipt interruption');
			const interrupted = await f.snapshot(); expect(interrupted.workdays).toHaveLength(1); expect(interrupted.events).toHaveLength(2);
			expect(interrupted.receipts.filter(row => row.operation === 'workday.start')).toEqual([]);
			await f.db.exec('DROP TRIGGER isolated_start_receipt_stop ON capacity_operation_receipts; DROP FUNCTION isolated_start_receipt_stop();');
			const receipt = await f.start(planned), recovered = await f.snapshot(); expect(receipt.workdayId).toBe(interrupted.workdays[0]?.id);
			const { receipts, ...truth } = recovered, { receipts: oldReceipts, ...prior } = interrupted;
			expect(truth).toEqual(prior); expect(receipts).toHaveLength(oldReceipts.length + 1);
			expect(await f.start(planned)).toEqual(receipt); expect(await f.snapshot()).toEqual(recovered);
		} finally { await f.close(); }
	});
	it('retains required event failure history and refuses to replay a failed partial admission as a successful native start', async () => {
		const f = await workdayStartDatabase(); try {
			const planned = await f.preflight();
			await f.db.exec(`CREATE FUNCTION isolated_poll_ready_stop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.event_type='assignment.polling_ready' THEN RAISE EXCEPTION 'isolated required event interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER isolated_poll_ready_stop BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION isolated_poll_ready_stop();`);
			await expect(f.start(planned)).rejects.toThrow('isolated required event interruption');
			const failed = await f.snapshot(); expect(failed.workdays).toHaveLength(1); expect(failed.workdays[0]?.status).toBe('failed');
			expect(failed.events.some(event => event.event_type === 'workday.schedule_failed')).toBe(true);
			expect(failed.receipts.filter(row => row.operation === 'workday.start')).toEqual([]);
			await f.db.exec('DROP TRIGGER isolated_poll_ready_stop ON capacity_workday_events; DROP FUNCTION isolated_poll_ready_stop();');
			await expect(f.start(planned)).rejects.toThrow(); expect(await f.snapshot()).toEqual(failed);
		} finally { await f.close(); }
	});
	it('starts the first recurring workday through real preflight native content graph and event persistence then retains exact intent on replay', async () => {
		const f = await workdayStartDatabase(); try {
			const original = structuredClone(f.intent);
			await f.publicService.createSchedule(f.principal, 'team', { id: 'schedule', purpose: 'Governed recurring planning', intent: f.intent, cadenceSeconds: 60, nextRunAt: f.intent.startsAt });
			const first = await f.store.tickCapacityWorkdaySchedule('team', 'schedule', f.intent.startsAt);
			expect(first?.action).toBe('created'); if (!first?.run) throw new Error('Actual first recurring run required');
			const truth = await f.snapshot(), plan = appliedWorkdaySchema.parse(first.run.parameters.appliedPlan);
			expect(plan).toMatchObject({ state: 'active', executionMode: original.executionMode, startsAt: original.startsAt,
				endsAt: new Date(Date.parse(original.startsAt) + original.durationSeconds * 1000).toISOString() });
			expect(first.schedule?.intent).toEqual(original); expect(first.schedule?.lastRunId).toBe(first.run.id);
			expect(truth.workdays).toHaveLength(1); expect(truth.receipts.map(row => row.operation).sort()).toEqual(['workday.preflight', 'workday.start']);
			expect(truth.nodes.length).toBeGreaterThan(0); expect(truth.events.map(row => row.event_type)).toEqual(['workday.started', 'assignment.polling_ready']);
			expect(truth.assignments).toEqual([]); expect(truth.ledger).toEqual([]);
			expect((await f.store.tickCapacityWorkdaySchedule('team', 'schedule', f.intent.startsAt))?.action).toBe('active_run');
			expect(await f.snapshot()).toEqual(truth); expect(f.calls).toHaveLength(1); expect(f.intent).toEqual(original);
		} finally { await f.close(); }
	});
	it('concurrent native recurring ticks have one first-start receipt and one graph event history without double successful admission', async () => {
		const f = await workdayStartDatabase(); try {
			await f.publicService.createSchedule(f.principal, 'team', { id: 'schedule', intent: f.intent, cadenceSeconds: 60, nextRunAt: f.intent.startsAt });
			const outcomes = await Promise.allSettled([f.store.tickCapacityWorkdaySchedule('team', 'schedule', f.intent.startsAt), f.store.tickCapacityWorkdaySchedule('team', 'schedule', f.intent.startsAt)]);
			const truth = await f.snapshot(); expect(truth.workdays).toHaveLength(1);
			expect(truth.receipts.filter(row => row.operation === 'workday.start')).toHaveLength(1);
			expect(truth.events.map(row => row.event_type)).toEqual(['workday.started', 'assignment.polling_ready']);
			expect(outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value?.action === 'created')).toHaveLength(1);
			expect(truth.assignments).toEqual([]); expect(truth.reservations).toEqual([]); expect(truth.ledger).toEqual([]);
			const replay = await f.store.tickCapacityWorkdaySchedule('team', 'schedule', f.intent.startsAt); expect(replay?.run?.id).toBe(truth.workdays[0]?.id);
			expect(await f.snapshot()).toEqual(truth);
		} finally { await f.close(); }
	});
	it('denies initial admission after the original productive window has elapsed without a new deadline or successful start receipt', async () => {
		const f = await workdayStartDatabase(); try {
			const elapsed = { ...f.intent, startsAt: new Date(Date.now() - 120_000).toISOString() };
			const before = await f.snapshot(); let admitted = false;
			try { const planned = await f.publicService.preflight(f.principal, 'team', elapsed); await f.start(planned); admitted = true; } catch { /* No fabricated expiry disposition. */ }
			const truth = await f.snapshot(); expect(admitted).toBe(false);
			expect(truth.workdays).toEqual(before.workdays); expect(truth.nodes).toEqual(before.nodes); expect(truth.events).toEqual(before.events);
			expect(truth.receipts.filter(row => row.operation === 'workday.start')).toEqual([]); expect(truth.reservations).toEqual([]); expect(truth.ledger).toEqual([]);
		} finally { await f.close(); }
	});
});
