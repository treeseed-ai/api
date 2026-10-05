import type { CapacityGovernanceDatabase } from '../../database.ts';

export interface ProviderLeasePrincipal {
	accessTokenId?: string;
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
	availabilitySessionId?: string | null,
): Promise<ProviderAssignmentLeaseAuthority> {
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) return { eligible: false, reasons: ['lease_time_invalid'], gates: {}, sessionId: null };
	await database.ensureInitialized();
	const assignment = await database.first(`SELECT * FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND capacity_provider_id = ? LIMIT 1`, [assignmentId, principal.teamId, principal.capacityProviderId]);
	if (!assignment) return { eligible: false, reasons: ['assignment_missing'], gates: {}, sessionId: null };
	const livingGraph = assignment.synthesized_from === 'living_execution_graph';
	if (!livingGraph) return { eligible: false, reasons: ['assignment_graph_authority_required'], gates: {}, sessionId: null };
	const [membership, reservation, workday, proxyHandle] = await Promise.all([
		database.first(`SELECT membership.status AS membership_status, provider.status AS provider_status FROM capacity_provider_team_memberships membership JOIN capacity_providers provider ON provider.id = membership.capacity_provider_id WHERE membership.id = ? AND membership.team_id = ? AND membership.capacity_provider_id = ? LIMIT 1`, [principal.membershipId, principal.teamId, principal.capacityProviderId]),
		database.first(`SELECT * FROM capacity_reservations WHERE id = ? AND team_id = ? AND membership_id = ? AND assignment_id = ? LIMIT 1`, [assignment.reservation_id, principal.teamId, principal.membershipId, assignmentId]),
		database.first(`SELECT status FROM capacity_workday_runs WHERE id = ? AND team_id = ? LIMIT 1`, [assignment.work_day_id, principal.teamId]),
		database.first(`SELECT status,expires_at FROM treedx_proxy_handles WHERE assignment_id = ? AND team_id = ? LIMIT 1`, [assignmentId, principal.teamId]),
	]);
	const selectedSessionId = availabilitySessionId || assignment.provider_session_id;
	let session = selectedSessionId
		? await database.first(`SELECT * FROM capacity_provider_availability_sessions WHERE id = ? AND membership_id = ? AND team_id = ? LIMIT 1`, [selectedSessionId, principal.membershipId, principal.teamId])
		: await database.first(`SELECT * FROM capacity_provider_availability_sessions WHERE membership_id = ? AND team_id = ? AND status = 'open' ORDER BY refreshed_at DESC, updated_at DESC LIMIT 1`, [principal.membershipId, principal.teamId]);
	// A provider can re-open availability while an already leased assignment is preparing its
	// source. Continue that exact lease under the same approved membership, never a new claim.
	const leaseExpiry = assignment.lease_expires_at ? Date.parse(String(assignment.lease_expires_at)) : Number.NaN;
	if (!availabilitySessionId && session?.status !== 'open' && assignment.status === 'leased'
		&& assignment.lease_state === 'leased' && Number.isFinite(leaseExpiry) && leaseExpiry > nowMs) {
		const current = await database.first(`SELECT * FROM capacity_provider_availability_sessions WHERE membership_id = ? AND team_id = ? AND capacity_provider_id = ? AND status = 'open' ORDER BY refreshed_at DESC, updated_at DESC LIMIT 1`,
			[principal.membershipId, principal.teamId, principal.capacityProviderId]);
		if (current) session = current;
	}
	const reasons: string[] = [];
	const expiry = (value: unknown, invalid: string, expired: string) => {
		if (value === undefined || value === null) return;
		const at = typeof value === 'string' && value ? Date.parse(value) : NaN;
		const reason = !Number.isFinite(at) ? invalid : at <= nowMs ? expired : null;
		if (reason && !reasons.includes(reason)) reasons.push(reason);
	};
	if (String(assignment.membership_id ?? '') !== principal.membershipId) reasons.push('assignment_membership_mismatch');
	if (membership?.membership_status !== 'approved') reasons.push('membership_not_approved');
	if (membership?.provider_status !== 'active') reasons.push('provider_not_active');
	if (!reservation) reasons.push('admission_reservation_missing');
	else {
		if (!['reserved', 'consuming'].includes(String(reservation.state))) reasons.push('reservation_not_active');
		expiry(reservation.expires_at, 'reservation_time_invalid', 'reservation_expired');
	}
	const activeWorkdayStatus = 'running';
	const validCompletedWorkdayLease = workday?.status === 'completed'
		&& assignment.status === 'leased'
		&& assignment.lease_state === 'leased'
		&& Number.isFinite(leaseExpiry)
		&& leaseExpiry > nowMs;
	if (!workday || (workday.status !== activeWorkdayStatus && !validCompletedWorkdayLease)) reasons.push('workday_not_active');
	if (proxyHandle?.status !== 'issued') reasons.push('assignment_workspace_not_ready');
	expiry(proxyHandle?.expires_at, 'assignment_workspace_time_invalid', 'assignment_workspace_expired');
	if (!session || session.status !== 'open') reasons.push('availability_session_not_open');
	if (session?.available_from !== undefined && session.available_from !== null) {
		const start = typeof session.available_from === 'string' && session.available_from ? Date.parse(session.available_from) : NaN;
		if (!Number.isFinite(start)) reasons.push('availability_time_invalid');
		else if (start > nowMs) reasons.push('availability_window_not_started');
	}
	const availableUntil = session?.available_until ?? session?.expires_at;
	expiry(session?.available_until, 'availability_time_invalid', 'availability_window_expired');
	expiry(session?.expires_at, 'availability_time_invalid', 'availability_window_expired');
	return {
		eligible: reasons.length === 0,
		reasons,
		sessionId: session?.id ? String(session.id) : null,
		gates: {
			assignmentAuthority: 'living_execution_graph',
			membershipStatus: membership?.membership_status ?? null,
			providerStatus: membership?.provider_status ?? null,
			reservationState: reservation?.state ?? null,
			workdayStatus: workday?.status ?? null,
			validCompletedWorkdayLease,
			workspaceStatus: proxyHandle?.status ?? null,
			sessionStatus: session?.status ?? null,
			availableUntil: availableUntil ?? null,
		},
	};
}
