import {
	capabilityDemandSchema,
	negotiateCapabilityOffer,
	type CapabilityNegotiationReceipt,
} from '@treeseed/sdk/capacity-provider';
import type { CapacityGovernanceDatabase } from '../../../../../database.ts';
import type { ProviderSynthesisExecutionProvider } from '../../../providers/provider-synthesis-context-service.ts';

export function negotiateAssignmentCapabilityOffers(
	value: unknown,
	executionProviders: ProviderSynthesisExecutionProvider[],
) {
	const capabilityDemand = value ? capabilityDemandSchema.parse(value) : null;
	const offerNegotiations = new Map<string, CapabilityNegotiationReceipt>();
	if (capabilityDemand) for (const provider of executionProviders) for (const offer of provider.offers) {
		const receipt = negotiateCapabilityOffer(capabilityDemand, offer);
		if (receipt.eligible) offerNegotiations.set(`${provider.id}:${offer.offerId}`, receipt);
	}
	return { capabilityDemand, offerNegotiations };
}

export async function persistCapabilityNegotiation(
	store: CapacityGovernanceDatabase,
	input: { assignmentId: string; teamId: string; receipt: CapabilityNegotiationReceipt | null | undefined; now: string },
) {
	if (!input.receipt) return;
	await store.run(`INSERT INTO capability_negotiation_receipts (id,team_id,assignment_id,demand_digest,offer_digest,receipt_json,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`, [
		`negotiation:${input.assignmentId}`, input.teamId, input.assignmentId, input.receipt.demandDigest,
		input.receipt.offerDigest, JSON.stringify(input.receipt), input.now,
	]);
}
