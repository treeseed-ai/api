import { afterEach, describe, expect, it } from 'vitest';
import { SessionEventService } from '../../../src/api/realtime/session-events.ts';
import { createTestPostgresDatabase, createTestStore } from '../../support/api-harness.ts';

describe('session event service', () => {
	const databases: ReturnType<typeof createTestPostgresDatabase>[] = [];
	afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

	it('persists ordered resumable team events without exposing another team', async () => {
		const database = createTestPostgresDatabase(); databases.push(database);
		const store = createTestStore(database);
		const service = new SessionEventService(store);
		const first = await service.publish({ eventType: 'discussion.updated', teamId: 'team-a', projectId: 'project-a', resourceId: 'discussion-a', payload: { messageId: 'message-a' } });
		await service.publish({ eventType: 'discussion.updated', teamId: 'team-b', resourceId: 'discussion-b' });
		const second = await service.publish({ eventType: 'discussion.updated', teamId: 'team-a', resourceId: 'discussion-a', payload: { messageId: 'message-b' } });

		expect(await service.list('team-a', first.sequence)).toEqual([second]);
		expect(await service.list('team-b', second.sequence)).toEqual([]);
	});

	it('delivers same-process events to active team subscribers', async () => {
		const database = createTestPostgresDatabase(); databases.push(database);
		const service = new SessionEventService(createTestStore(database));
		const received: number[] = [];
		const unsubscribe = await service.subscribe('team-a', (event) => received.push(event.sequence));
		const event = await service.publish({ eventType: 'resource.invalidated', teamId: 'team-a', resourceId: 'resource-a' });
		unsubscribe();
		expect(received).toEqual([event.sequence]);
	});

	it('rejects transient token deltas instead of persisting replayable content',async()=>{
		const database=createTestPostgresDatabase();databases.push(database);
		const service=new SessionEventService(createTestStore(database));
		await expect(service.publish({eventType:'agent.token.delta',teamId:'team-a',resourceId:'run-a',payload:{delta:'secret partial output'}})).rejects.toThrow('Transient token deltas');
		expect(await service.list('team-a',0)).toEqual([]);
	});
});
