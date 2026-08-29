import { describe, expect, it } from 'vitest';
import { resolveTeamCommunicationTargets } from '../../../../../src/api/capacity/services/capacity/invocations/communication-target-resolution.ts';

const chatClass = (slug: string) => ({ handlerRefs: { agents: [{ slug, activities: { chat: { enabled: true, handler: 'writer' } } }] } });

describe('team communication target resolution', () => {
	it('expands an unqualified handle across projects and keeps qualified handles exact', async () => {
		const store = {
			async listTeamProjects() { return [{ id: 'project-api', slug: 'api', status: 'active' }, { id: 'project-sdk', slug: 'sdk', status: 'active' }]; },
			async listProjectAgentClassesPage() { return { items: [chatClass('architect')] }; },
		};
		await expect(resolveTeamCommunicationTargets(store, 'team-a', [{ projectSlug: null, agentSlug: 'architect', requirement: 'required', address: '@architect' }]))
			.resolves.toEqual([
				{ projectId: 'project-api', projectSlug: 'api', agentSlug: 'architect', requirement: 'required' },
				{ projectId: 'project-sdk', projectSlug: 'sdk', agentSlug: 'architect', requirement: 'required' },
			]);
		await expect(resolveTeamCommunicationTargets(store, 'team-a', [{ projectSlug: 'sdk', agentSlug: 'architect', requirement: 'optional', address: '@sdk/architect' }]))
			.resolves.toEqual([{ projectId: 'project-sdk', projectSlug: 'sdk', agentSlug: 'architect', requirement: 'optional' }]);
	});

	it('reads active agent classes directly from the control-plane store', async () => {
		const store = {
			async listTeamProjects() { return [{ id: 'project-sdk', slug: 'sdk', status: 'active' }]; },
			async all() { return [{ handler_refs_json: JSON.stringify({ agents: [{ slug: 'architect', activities: { chat: { enabled: true, handler: 'writer' } } }] }) }]; },
		};
		await expect(resolveTeamCommunicationTargets(store, 'team-a', [{ projectSlug: null, agentSlug: 'architect', requirement: 'required', address: '@architect' }]))
			.resolves.toEqual([{ projectId: 'project-sdk', projectSlug: 'sdk', agentSlug: 'architect', requirement: 'required' }]);
	});
});
