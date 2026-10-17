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
