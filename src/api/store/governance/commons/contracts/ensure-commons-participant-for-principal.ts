import { randomUUID } from 'node:crypto';
import { COMMONS_WEIGHT_POLICY_VERSION,isoNow,ControlPlaneStore,optionalStringValue,parseJson } from "../../../../persistence/store.ts";
export async function ensureCommonsParticipantForPrincipalMethod(this: ControlPlaneStore, principal, input: any = {}) {
    await this.ensureInitialized();
    if (!principal?.id) {
        const error: Error & Record<string, any> = new Error('Authenticated Commons participant is required.');
        error.status = 401;
        throw error;
    }
    const team = await this.ensureCommonsTeam();
    await this.upsertTeamMember(team.id, principal.id, 'viewer');
    const timestamp = isoNow();
    const user = await this.first(`SELECT * FROM users WHERE id = ? LIMIT 1`, [principal.id]).catch(() => null);
    const email = await this.first(`SELECT verified_at, status FROM user_email_addresses WHERE user_id = ? AND is_primary = 1 LIMIT 1`, [principal.id]).catch(() => null);
    const verifiedEmail = Boolean(email?.verified_at || email?.status === 'verified');
    const existing = await this.first(`SELECT * FROM commons_participants WHERE user_id = ? LIMIT 1`, [principal.id]);
    const displayName = optionalStringValue(input.displayName) ?? optionalStringValue(user?.display_name) ?? optionalStringValue(principal.displayName) ?? null;
    const weights = this.computeCommonsWeights({ verifiedEmail, participant: existing, principal });
    if (existing?.id) {
        await this.run(`UPDATE commons_participants
				 SET team_id = ?, status = CASE WHEN status = 'archived' THEN 'active' ELSE status END, display_name = ?,
					 verified_email = ?, base_weight = ?, trust_weight = ?, contribution_weight = ?, stakeholder_weight = ?,
					 delegated_weight = ?, total_weight = ?, metadata_json = ?, updated_at = ?
				 WHERE id = ?`, [
            team.id,
            displayName,
            verifiedEmail ? 1 : 0,
            weights.baseWeight,
            weights.trustWeight,
            weights.contributionWeight,
            weights.stakeholderWeight,
            weights.delegatedWeight,
            weights.totalWeight,
            JSON.stringify({ ...parseJson(existing.metadata_json, {}), ...(input.metadata ?? {}) }),
            timestamp,
            existing.id,
        ]);
        return this.getCommonsParticipant(existing.id);
    }
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commons_participants (
				id, user_id, team_id, status, display_name, verified_email, base_weight, trust_weight,
				contribution_weight, stakeholder_weight, delegated_weight, total_weight, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        principal.id,
        team.id,
        displayName,
        verifiedEmail ? 1 : 0,
        weights.baseWeight,
        weights.trustWeight,
        weights.contributionWeight,
        weights.stakeholderWeight,
        weights.delegatedWeight,
        weights.totalWeight,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommonsGovernanceEvent({
        eventType: 'participant.joined',
        actorType: 'user',
        actorId: principal.id,
        participantId: id,
        nextState: 'active',
        message: 'Registered participant joined TreeSeed Commons.',
        evidence: { teamId: team.id, role: 'viewer', policyVersion: COMMONS_WEIGHT_POLICY_VERSION },
    });
    return this.getCommonsParticipant(id);
}
