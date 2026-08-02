import { isoNow,MarketControlPlaneStore,serializeCommerceStewardshipAssignment } from "../../../../persistence/store.ts";
export async function updateCommerceStewardshipAssignmentMethod(this: MarketControlPlaneStore, assignmentId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.first(`SELECT * FROM commerce_stewardship_assignments WHERE id = ?`, [assignmentId]);
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_stewardship_assignments
			 SET display_name = ?, responsibilities_json = ?, visible_to_buyers = ?, ends_at = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        input.displayName === undefined ? existing.display_name : input.displayName,
        input.responsibilities === undefined ? existing.responsibilities_json : JSON.stringify(input.responsibilities ?? []),
        input.visibleToBuyers === undefined ? existing.visible_to_buyers : input.visibleToBuyers ? 1 : 0,
        input.endsAt === undefined ? existing.ends_at : input.endsAt,
        input.metadata === undefined ? existing.metadata_json : JSON.stringify(input.metadata ?? {}),
        timestamp,
        assignmentId,
    ]);
    const updated = serializeCommerceStewardshipAssignment(await this.first(`SELECT * FROM commerce_stewardship_assignments WHERE id = ?`, [assignmentId]));
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_stewardship.assignment.updated',
        objectType: 'commerce_stewardship_assignment',
        objectId: assignmentId,
        priorState: existing.ends_at ? 'ended' : 'active',
        nextState: updated.endsAt ? 'ended' : 'active',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: existing.product_id,
    });
    return updated;
}
