import { ControlPlaneStore,serializeGovernanceElectorateSnapshot } from "../../../../../persistence/store.ts";
export async function latestGovernanceElectorateSnapshotMethod(this: ControlPlaneStore, proposalId, version) {
    await this.ensureInitialized();
    return serializeGovernanceElectorateSnapshot(await this.first(`SELECT * FROM governance_electorate_snapshots
			 WHERE proposal_id = ? AND proposal_version = ?
			 ORDER BY created_at DESC LIMIT 1`, [proposalId, version]));
}
