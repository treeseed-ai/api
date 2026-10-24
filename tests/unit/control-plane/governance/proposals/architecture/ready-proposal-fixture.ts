import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import type { AgentDefinition } from '@treeseed/sdk/agent-capacity';
/** Governed example data, not a copy of the canonical schema or a readiness implementation. */
export function readyWorkItem() {
	return { id: 'verify-boundary', activity: 'acting', agentClass: 'boundary-author', workspace: 'read-only',
		review: 'required', objective: 'Independently verify the exact governed boundary.', dependsOn: [] as string[],
		requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: [] },
		requiredCapabilities: ['verification'],
		acceptanceCriteria: ['Read back the exact source and record independent verification.'],
		estimate: { expectedSeconds: 30, maximumSeconds: 60 },
		reviewEstimate: { expectedSeconds: 10, maximumSeconds: 20 }, maximumReviewCycles: 2 };
}
export function readyProposal() {
	return { schemaVersion: 'treeseed.proposal/v1', id: 'proposal', projectId: 'project', title: 'Governed boundary',
		request: 'Verify the exact governed boundary.', summary: 'One bounded, independently reviewed work item.',
		status: 'draft', executionPlan: { workItems: [readyWorkItem()] } };
}

/** Current contribution content INPUT; no estimating execution is claimed. */
export function readyContributionProposal() {
	const base = readyProposal(), { agentClass: _class, ...item } = base.executionPlan.workItems[0]!;
	return { ...base, schemaVersion: 'treeseed.proposal/v2', groupIds: ['portfolio-runtime'],
		executionPlan: { workItems: [{ ...item,
			estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: 'controlled-estimate', revision: 1 },
			estimate: { ...item.estimate, rationale: 'Controlled own implementation estimate.' },
			reviewEstimate: { ...item.reviewEstimate, rationale: 'Controlled own independent review estimate.' },
		}] } };
}

/** Exact controlled library inputs; the original native test publishes and reads these bytes. */
export function nativeProposalProfileInputs(configured: Record<string, AgentDefinition>, projectId: string, canonicalSupply: boolean) {
	const profiles = Object.values(configured).filter(value => configured[`${projectId}:${value.agentClass}`] === value)
		.map(value => {
			const definition = structuredClone(value);
			if (canonicalSupply) {
				definition.capabilities = ['treeseed.research.verification'];
				for (const profile of Object.values(definition.activityProfiles)) if (profile) profile.permissions.content.read.push('decision');
			}
			return definition;
		});
	// The public Workday boundary also requires one governed closeout profile.
	// Publish it with these same exact library bytes before any governance work.
	const closeout = profiles[0]; assert.ok(closeout);
	closeout.activityProfiles.reporting = { handler: 'reporter',
		prompt: { system: 'Commit the deterministic canonical Workday closeout.' },
		permissions: { content: { read: ['knowledge', 'proposal'], write: ['note'] }, tools: [] },
		dependsOn: { events: ['workday-closing'] } };
	const profileInputs = profiles.map(definition => ({ definition, path: `agents/${definition.agentClass}.md`,
		raw: `---\n${stringify(definition)}---\n` }));
	return { profileInputs, closeout };
}

/** Actual native user/owner inputs; the original membership and electorate readers remain authoritative. */
export async function prepareNativeProposalVoting(f: {
 store: Pick<import('../../../../../../src/api/persistence/store.ts').ControlPlaneStore,'upsertTeamMember'|'governanceEligibleVoters'|'startGovernanceProposalVoting'>;
 query: (sql:string,params:unknown[])=>Promise<unknown>; principal:{id:string};
},proposalId:string,profileTime:string) {
	await f.query("INSERT INTO users(id,status,display_name,metadata_json,created_at,updated_at) VALUES(?,'active','Native proposal operator','{}',?,?)", [f.principal.id,profileTime,profileTime]);
	await f.query("INSERT INTO roles(id,key,created_at) VALUES('native-proposal-owner','team_owner',?) ON CONFLICT(key) DO NOTHING",[profileTime]);
	const voter = await f.store.upsertTeamMember('team',f.principal.id,'team_owner');
	assert.ok(voter); assert.deepEqual({userId:voter.userId,status:voter.status,roles:voter.roles},{userId:f.principal.id,status:'active',roles:['team_owner']});
	const voters=await f.store.governanceEligibleVoters('team','admin_approval_v1');
	assert.ok(voters.some(v=>v.userId===f.principal.id&&v.chambers.some(c=>c.chamberId==='admin_chamber'&&c.eligible===true&&c.weight===1)));
	await f.store.startGovernanceProposalVoting(f.principal,proposalId,{expectedProposalVersion:1});
}
