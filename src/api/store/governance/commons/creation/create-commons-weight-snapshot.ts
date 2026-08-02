import { randomUUID } from 'node:crypto';
import { COMMONS_WEIGHT_POLICY_VERSION,isoNow,MarketControlPlaneStore,serializeCommonsWeightSnapshot } from "../../../../persistence/store.ts";
export async function createCommonsWeightSnapshotMethod(this: MarketControlPlaneStore, participantId, evidence: any = {}) {
    await this.ensureInitialized();
    const participant = await this.getCommonsParticipant(participantId);
    if (!participant)
        return null;
    const timestamp = isoNow();
    const id = randomUUID();
    await this.run(`INSERT INTO commons_weight_snapshots (
				id, participant_id, policy_version, base_weight, verified_email_weight, account_age_weight,
				contribution_weight, stakeholder_weight, trust_role_weight, delegated_weight, total_weight, evidence_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        participantId,
        COMMONS_WEIGHT_POLICY_VERSION,
        participant.baseWeight,
        participant.verifiedEmail ? 0.25 : 0,
        0,
        participant.contributionWeight,
        participant.stakeholderWeight,
        participant.trustWeight,
        participant.delegatedWeight,
        participant.totalWeight,
        JSON.stringify({ ...evidence, participantStatus: participant.status }),
        timestamp,
    ]);
    return serializeCommonsWeightSnapshot(await this.first(`SELECT * FROM commons_weight_snapshots WHERE id = ?`, [id]));
}
