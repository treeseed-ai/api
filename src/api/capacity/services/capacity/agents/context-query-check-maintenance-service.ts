import type { ContextQueryCheckService } from './context-query-check-service.ts';

type MaintenanceService=Pick<ContextQueryCheckService,'recheckDue'>;
type MaintenanceResult=Awaited<ReturnType<MaintenanceService['recheckDue']>>;

export class ContextQueryCheckMaintenanceScheduler {
	private nextRunAt=0;
	private running:Promise<MaintenanceResult|null>|null=null;

	constructor(
		private readonly service:MaintenanceService,
		private readonly intervalMs=30_000,
	) {
		if(!Number.isFinite(intervalMs)||intervalMs<1_000) throw new Error('Context-query check maintenance interval must be at least 1000ms.');
	}

	runIfDue(now=new Date()):Promise<MaintenanceResult|null> {
		if(this.running) return this.running;
		if(now.getTime()<this.nextRunAt) return Promise.resolve(null);
		this.nextRunAt=now.getTime()+this.intervalMs;
		this.running=this.service.recheckDue(now).finally(()=>{this.running=null;});
		return this.running;
	}
}
