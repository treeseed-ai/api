import type { CapacityGovernanceDatabase } from '../database.ts';

export interface ProviderLeasePrincipal {
	membershipId: string;
	teamId: string;
	capacityProviderId: string;
}

export interface ProviderAssignmentLeaseAuthority {
	eligible: boolean;
	reasons: string[];
	gates: Record<string, unknown>;
	sessionId: string | null;
}

export async function evaluateProviderAssignmentLeaseAuthority(
	database: CapacityGovernanceDatabase,
	principal: ProviderLeasePrincipal,
	assignmentId: string,
	now = new Date().toISOString(),
): Promise<ProviderAssignmentLeaseAuthority> {
	await database.ensureInitialized();
	const assignment = await database.first(`SELECT * FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND capacity_provider_id = ? LIMIT 1`, [assignmentId, principal.teamId, principal.capacityProviderId]);
	if (!assignment) return { eligible: false, reasons: ['assignment_missing'], gates: {}, sessionId: null };
	const [membership, reservation, workday, proxyHandle] = await Promise.all([
		database.first(`SELECT membership.status AS membership_status, provider.status AS provider_status FROM capacity_provider_team_memberships membership JOIN capacity_providers provider ON provider.id = membership.capacity_provider_id WHERE membership.id = ? AND membership.team_id = ? AND membership.capacity_provider_id = ? LIMIT 1`, [principal.membershipId, principal.teamId, principal.capacityProviderId]),
		database.first(`SELECT reservation.*, capacity_grant.status AS grant_status, allocation_set.status AS allocation_status FROM capacity_reservations reservation LEFT JOIN capacity_grants capacity_grant ON capacity_grant.id = reservation.grant_id LEFT JOIN capacity_allocation_sets allocation_set ON allocation_set.id = reservation.allocation_set_id WHERE reservation.id = ? AND reservation.team_id = ? AND reservation.membership_id = ? AND reservation.assignment_id = ? LIMIT 1`, [assignment.reservation_id, principal.teamId, principal.membershipId, assignmentId]),
		database.first(`SELECT status FROM workday_capacity_envelopes WHERE id = ? AND team_id = ? AND project_id = ? LIMIT 1`, [assignment.work_day_id, principal.teamId, assignment.project_id]),
		assignment.synthesized_from === 'workday_demand'
			? database.first(`SELECT status FROM treedx_proxy_handles WHERE assignment_id = ? AND team_id = ? LIMIT 1`, [assignmentId, principal.teamId])
			: Promise.resolve(null),
	]);
	const session = assignment.provider_session_id
		? await database.first(`SELECT * FROM capacity_provider_availability_sessions WHERE id = ? AND membership_id = ? AND team_id = ? LIMIT 1`, [assignment.provider_session_id, principal.membershipId, principal.teamId])
		: await database.first(`SELECT * FROM capacity_provider_availability_sessions WHERE membership_id = ? AND team_id = ? AND status = 'open' ORDER BY refreshed_at DESC, updated_at DESC LIMIT 1`, [principal.membershipId, principal.teamId]);
	const reasons: string[] = [];
	if (String(assignment.membership_id ?? '') !== principal.membershipId) reasons.push('assignment_membership_mismatch');
	if (membership?.membership_status !== 'approved') reasons.push('membership_not_approved');
	if (membership?.provider_status !== 'active') reasons.push('provider_not_active');
	if (!reservation) reasons.push('admission_reservation_missing');
	else {
		if (!['reserved', 'consuming'].includes(String(reservation.state))) reasons.push('reservation_not_active');
		if (reservation.grant_status !== 'active') reasons.push('grant_not_active');
		if (reservation.allocation_status !== 'active') reasons.push('allocation_not_active');
	}
	const leaseExpiry = assignment.lease_expires_at ? Date.parse(String(assignment.lease_expires_at)) : Number.NaN;
	const validCompletedWorkdayLease = workday?.status === 'completed'
		&& assignment.status === 'leased'
		&& assignment.lease_state === 'leased'
		&& Number.isFinite(leaseExpiry)
		&& leaseExpiry > Date.parse(now);
	if (!workday || (workday.status !== 'active' && !validCompletedWorkdayLease)) reasons.push('workday_not_active');
	if (assignment.synthesized_from === 'workday_demand' && proxyHandle?.status !== 'issued') reasons.push('assignment_workspace_not_ready');
	if (!session || session.status !== 'open') reasons.push('availability_session_not_open');
	if (session?.available_from && Date.parse(String(session.available_from)) > Date.parse(now)) reasons.push('availability_window_not_started');
	const availableUntil = session?.available_until ?? session?.expires_at;
	if (availableUntil && Date.parse(String(availableUntil)) <= Date.parse(now)) reasons.push('availability_window_expired');
	return {
		eligible: reasons.length === 0,
		reasons,
		sessionId: session?.id ? String(session.id) : null,
		gates: {
			membershipStatus: membership?.membership_status ?? null,
			providerStatus: membership?.provider_status ?? null,
			reservationState: reservation?.state ?? null,
			grantStatus: reservation?.grant_status ?? null,
			allocationStatus: reservation?.allocation_status ?? null,
			workdayStatus: workday?.status ?? null,
			validCompletedWorkdayLease,
			workspaceStatus: proxyHandle?.status ?? null,
			sessionStatus: session?.status ?? null,
			availableUntil: availableUntil ?? null,
		},
	};
}
