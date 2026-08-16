import { describe,expect,it,vi } from 'vitest';
import { ContextQueryCheckMaintenanceScheduler } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-maintenance-service.ts';

describe('context-query check maintenance',()=>{
	it('runs due isolated checks once per cadence while preserving the in-flight result',async()=>{
		let release:((value:{considered:number;passing:number;failing:number;failures:[]})=>void)|null=null;
		const service={recheckDue:vi.fn(()=>new Promise<{considered:number;passing:number;failing:number;failures:[]}>(resolve=>{release=resolve;}))};
		const scheduler=new ContextQueryCheckMaintenanceScheduler(service,30_000);
		const first=scheduler.runIfDue(new Date('2026-08-13T22:00:00.000Z'));
		const concurrent=scheduler.runIfDue(new Date('2026-08-13T22:00:01.000Z'));
		expect(service.recheckDue).toHaveBeenCalledTimes(1);
		release!({considered:1,passing:1,failing:0,failures:[]});
		expect(await first).toEqual(await concurrent);
		expect(await scheduler.runIfDue(new Date('2026-08-13T22:00:29.000Z'))).toBeNull();
		service.recheckDue.mockResolvedValueOnce({considered:0,passing:0,failing:0,failures:[]});
		await scheduler.runIfDue(new Date('2026-08-13T22:00:30.000Z'));
		expect(service.recheckDue).toHaveBeenCalledTimes(2);
	});
});
