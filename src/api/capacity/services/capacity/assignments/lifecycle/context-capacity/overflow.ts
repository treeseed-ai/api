import type { DurableProviderAssignment } from '../../../../../repositories/capacity/assignments/assignment.ts';

const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

export async function quarantineContextOverflowOffer(input:{
	store:{run(query:string,parameters?:unknown[]):Promise<unknown>};
	assignment:DurableProviderAssignment;
	code:string|undefined;
	observedAt:string;
}) {
	if(input.code!=='provider_context_capacity_overflow')return null;
	const offerId=String(record(input.assignment.metadata).offerId??'').trim();
	if(offerId)await input.store.run(`UPDATE execution_capability_offers SET status='context_overflow',last_seen_at=? WHERE capacity_provider_id=? AND execution_provider_id=? AND offer_id=?`,[
		input.observedAt,input.assignment.capacityProviderId,input.assignment.executionProviderId,offerId,
	]);
	return {code:input.code,offerId,observedAt:input.observedAt,advertisedCapacity:record(input.assignment.metadata).contextCapacity??null};
}
