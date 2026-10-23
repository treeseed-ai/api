import { describe, expect, it } from 'vitest';
import { resolveTeamCommunicationTargets } from '../../../../../src/api/capacity/services/capacity/invocations/communication-target-resolution.ts';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';

const agent = (slug: string, profiles: Record<string, unknown>) => ({ schemaVersion: 'treeseed.agent/v1', id: `sdk/${slug}`,
	name: slug, agentClass: slug, purpose: `Act as the ${slug} for this project.`, responsibilities: ['Answer authorized work.'],
	capabilities: ['discussion'], context: { include: ['assignment-subject'] }, activityProfiles: profiles });
const chat = { handler: 'writer', permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'] },
	prompt: { system: 'Research and answer the exact addressed discussion message.' } };
const chatClass = (slug: string) => ({ handlerRefs: { agents: [agent(slug, { chat })] } });

describe('team communication target resolution', () => {
	it.each([
		[],
	])('rejects missing agent definitions without assigning work (%j)', async (...items) => {
		const store = {
			async listTeamProjects() { return [{ id: 'sdk-id', slug: 'sdk' }]; },
			async listProjectAgentClassesPage() { return { items }; },
		};
		await expect(resolveTeamCommunicationTargets(store, 'team', [{ projectSlug: 'sdk', agentSlug: 'architect', requirement: 'required', address: '@sdk/architect' }]))
			.rejects.toMatchObject({ status: 404, code: 'communication_agent_not_found' });
	});
	it('reports invalid addressed definitions explicitly instead of silently dropping group members', async () => {
		for (const definition of [{ ...agent('architect', { chat }), schemaVersion: 'retired' }, agent('architect', {})]) {
			const store = {
				async listTeamProjects() { return [{ id: 'api-id', slug: 'api' }]; },
				async listProjectAgentClassesPage() { return { items: [{ handlerRefs: { agents: [definition] } }] }; },
			};
			await expect(resolveTeamCommunicationTargets(store, 'team', [{ projectSlug: null, agentSlug: 'architect', requirement: 'required', address: '@architect' }]))
				.rejects.toMatchObject({ code: 'communication_agent_definition_invalid', status: 409 });
		}
	});
	it('retains mentioned members independently of class status or enabled activity for explicit admission checks', async () => {
		const store = {
			async listTeamProjects() { return [{ id: 'api-id', slug: 'api' }]; },
			async listProjectAgentClassesPage() { return { items: [{ status: 'paused', handlerRefs: { agents: [
				{ ...agent('tester', { acting: { ...chat, handler: 'actor' } }), groupIds: ['delivery'] },
			] } }] }; },
		};
		await expect(resolveTeamCommunicationTargets(store, 'team', [{ projectSlug: null, agentSlug: 'delivery', requirement: 'required', address: '@delivery' }]))
			.resolves.toEqual([{ projectId: 'api-id', projectSlug: 'api', agentSlug: 'tester', requirement: 'required' }]);
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
	it('expands group mentions to actual member identities across projects without class filtering', async () => {
		const store = {
			async listTeamProjects() { return [{ id: 'api-id', slug: 'api' }, { id: 'agent-id', slug: 'agent' }]; },
			async listProjectAgentClassesPage() { return { items: [{ handlerRefs: { agents: [
				{ ...agent('tester', { chat }), agentClass: 'quality', groupIds: ['delivery'] },
				{ ...agent('technical-writer', { chat }), agentClass: 'documentation', groupIds: ['delivery'] },
				{ ...agent('engineer', { chat }), groupIds: ['another-group'] },
			] } }] }; },
		};
		await expect(resolveTeamCommunicationTargets(store, 'team', [{ projectSlug: null, agentSlug: 'delivery', requirement: 'required', address: '@delivery' }]))
			.resolves.toEqual(['agent', 'api'].flatMap(project => ['technical-writer', 'tester'].map(agentSlug => ({
				projectId: `${project}-id`, projectSlug: project, agentSlug, requirement: 'required',
			}))));
		await expect(resolveTeamCommunicationTargets(store, 'team', [{ projectSlug: 'api', agentSlug: 'delivery', requirement: 'optional', address: '@api/delivery' }]))
			.resolves.toEqual(['technical-writer', 'tester'].map(agentSlug => ({ projectId: 'api-id', projectSlug: 'api', agentSlug, requirement: 'optional' })));
	});
	it('resolves all inventory pages and deduplicates overlapping group and shared-name mentions', async () => {
		const cursor = encodeCapacityPageCursor({ createdAt: '2026-10-23T00:00:00Z', id: 'first' });
		const store = {
			async listTeamProjects() { return [{ id: 'api-id', slug: 'api' }]; },
			async listProjectAgentClassesPage(_project: string, page: { cursor: unknown }) {
				return page.cursor ? { items: [{ handlerRefs: { agents: [{ ...agent('tester', { chat }), groupIds: ['delivery'] }] } }], page: { hasMore: false, nextCursor: null } }
					: { items: [chatClass('architect')], page: { hasMore: true, nextCursor: cursor } };
			},
		};
		await expect(resolveTeamCommunicationTargets(store, 'team', [
			{ projectSlug: null, agentSlug: 'delivery', requirement: 'optional', address: '@delivery' },
			{ projectSlug: null, agentSlug: 'tester', requirement: 'required', address: '@tester' },
		])).resolves.toEqual([{ projectId: 'api-id', projectSlug: 'api', agentSlug: 'tester', requirement: 'required' }]);
	});
});
