import { enumValue,isoNow,MarketControlPlaneStore,serializeCommerceGovernancePolicy,stringValue } from "../../../../persistence/store.ts";
export async function updateCommerceGovernancePolicyMethod(this: MarketControlPlaneStore, policyId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.first(`SELECT * FROM commerce_governance_policies WHERE id = ?`, [policyId]);
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_governance_policies
			 SET title = ?, approval_rules_json = ?, quorum_rules_json = ?, buyer_visible_summary = ?, status = ?, updated_at = ?
			 WHERE id = ?`, [
        input.title === undefined ? existing.title : stringValue(input.title, String(existing.title ?? '')),
        input.approvalRules === undefined ? existing.approval_rules_json : JSON.stringify(input.approvalRules ?? {}),
        input.quorumRules === undefined ? existing.quorum_rules_json : JSON.stringify(input.quorumRules ?? {}),
        input.buyerVisibleSummary === undefined ? existing.buyer_visible_summary : input.buyerVisibleSummary,
        input.status === undefined ? existing.status : enumValue(input.status, new Set(['draft', 'active', 'superseded', 'archived']), String(existing.status ?? 'draft')),
        timestamp,
        policyId,
    ]);
    const updated = serializeCommerceGovernancePolicy(await this.first(`SELECT * FROM commerce_governance_policies WHERE id = ?`, [policyId]));
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_governance_policy.updated',
        objectType: 'commerce_governance_policy',
        objectId: policyId,
        priorState: existing.status,
        nextState: updated.status,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: existing.product_id,
        relatedTeamId: existing.team_id,
    });
    return updated;
}
