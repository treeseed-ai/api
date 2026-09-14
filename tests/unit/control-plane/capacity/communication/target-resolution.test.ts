import { describe, expect, it } from 'vitest';
import { resolveTeamCommunicationTargets } from '../../../../../src/api/capacity/services/capacity/invocations/communication-target-resolution.ts';

const agent = (slug: string, profiles: Record<string, unknown>) => ({ schemaVersion: 'treeseed.agent/v1', id: `sdk/${slug}`,
	name: slug, agentClass: slug, purpose: `Act as the ${slug} for this project.`, responsibilities: ['Answer authorized work.'],
	capabilities: ['discussion'], context: { include: ['assignment-subject'] }, activityProfiles: profiles });
const chat = { handler: 'writer', permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'] },
	prompt: { system: 'Research and answer the exact addressed discussion message.' } };
const chatClass = (slug: string) => ({ handlerRefs: { agents: [agent(slug, { chat })] } });

describe('team communication target resolution', () => {
	it.each([
		[],
		[{ ...chatClass('architect'), status: 'disabled' }],
		[{ handlerRefs: { agents: [{ ...agent('architect', { chat }), schemaVersion: 'retired' }] } }],
		[{ handlerRefs: { agents: [agent('architect', {})] } }],
		[{ handlerRefs: { agents: [agent('architect', { acting: { ...chat, handler: 'actor' } })] } }],
	])('rejects missing or disabled chat authority without assigning work (%j)', async (...items) => {
		const store = {
			async listTeamProjects() { return [{ id: 'sdk-id', slug: 'sdk' }]; },
			async listProjectAgentClassesPage() { return { items }; },
		};
		await expect(resolveTeamCommunicationTargets(store, 'team', [{ projectSlug: 'sdk', agentSlug: 'architect', requirement: 'required', address: '@sdk/architect' }]))
			.rejects.toMatchObject({ status: 404, code: 'communication_agent_not_found' });
	});
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
			async all() { return [{ handler_refs_json: JSON.stringify({ agents: [agent('architect', { chat })] }) }]; },
		};
		await expect(resolveTeamCommunicationTargets(store, 'team-a', [{ projectSlug: null, agentSlug: 'architect', requirement: 'required', address: '@architect' }]))
			.resolves.toEqual([{ projectId: 'project-sdk', projectSlug: 'sdk', agentSlug: 'architect', requirement: 'required' }]);
	});
});
