import { reconcileSupersededTreeDxAuthoringState } from '../../../../services/treedx/repositories/treedx-authoring-journal.ts';

type Store=Parameters<typeof reconcileSupersededTreeDxAuthoringState>[0];

export function reconcileInterruptedOperatorAuthoring(input:{
	store:Store;projectId:string;repositoryId:string;ref:string;observedHead:string;actorId?:string|null;
}) {
	return reconcileSupersededTreeDxAuthoringState(input.store,{
		projectId:input.projectId,repositoryId:input.repositoryId,ref:input.ref,observedHead:input.observedHead,
		actorType:'service',actorId:input.actorId??'agent-lab-authoring-recovery',advanceProjectContentRef:false,
	});
}
