import type { HostedInfrastructureAuthorityRequest, HostedInfrastructureVaultMaterial } from '@treeseed/deployment/infrastructure/opentofu';

const ENV_REFERENCE = /^TREESEED_[A-Z0-9]+(?:_[A-Z0-9]+)*$/u;
type ExternalMaterial = { values: Record<string, string>; expiresAt: string | null; authorityId?: string; authorityVersion?: number };

export async function resolveHostedVaultMaterial(input: {
	store: any;
	request: HostedInfrastructureAuthorityRequest;
	env?: NodeJS.ProcessEnv;
	externalResolver?: (input: { authority: Record<string, unknown>; request: HostedInfrastructureAuthorityRequest }) => Promise<ExternalMaterial>;
	interactiveResolver?: (request: HostedInfrastructureAuthorityRequest) => Promise<ExternalMaterial>;
}): Promise<HostedInfrastructureVaultMaterial> {
	const request = input.request, statePurpose = request.purpose !== 'provider';
	const connectionRef = request.connectionRef;
	const profile = request.credentialProfileId;
	if (!connectionRef) throw new Error('Hosted state authority has no team storage connection.');
	const row = await input.store.first(`SELECT a.*, c.provider_id FROM provider_credential_authorities a
		JOIN team_service_connections c ON c.id = a.connection_id AND c.team_id = a.team_id
		JOIN team_service_capability_bindings b ON b.connection_id = c.id AND b.team_id = c.team_id
			AND b.credential_profile_id = a.credential_profile_id AND b.capability_type = ? AND b.status = 'configured'
		WHERE a.team_id = ? AND (a.connection_id = ? OR c.display_name = ?) AND c.provider_id = ? AND c.status = 'active'
		AND a.credential_profile_id = ? AND (a.status = 'ready' OR (a.scheme = 'client-encrypted' AND a.status = 'interactive-only'))`, [request.capabilities[0], request.teamId, connectionRef, connectionRef, statePurpose ? 'cloudflare' : request.provider, profile]);
	if (!row) throw new Error(`Ready ${profile} service-vault authority is required for hosted ${request.purpose}.`);
	const granted = JSON.parse(row.capabilities_json ?? '[]');
	const requiredCapabilities = request.capabilities;
	if (requiredCapabilities.some((capability) => !granted.includes(capability))) throw new Error(`The ${profile} authority does not grant the requested capabilities.`);
	let resolved: ExternalMaterial;
	if (row.scheme === 'environment-reference' && request.purpose === 'provider') {
		if (!ENV_REFERENCE.test(row.reference)) throw new Error('Hosted provider environment authority uses an invalid reference.');
		const token = (input.env ?? process.env)[row.reference]; if (!token) throw new Error(`Hosted provider authority ${row.reference} is unavailable.`);
		resolved = { values: { apiToken: token }, expiresAt: null };
	} else if (row.scheme === 'client-encrypted' && input.interactiveResolver) resolved = await input.interactiveResolver(request);
	else if (['external-vault', 'workload-identity'].includes(row.scheme) && input.externalResolver) resolved = await input.externalResolver({ authority: row, request });
	else throw new Error(`Hosted authority scheme ${row.scheme} is not configured for unattended service-vault resolution.`);
	return { schemaVersion: 'treeseed.service-credential-material/v1', source: 'treeseed-service-credential-vault', requestId: request.requestId,
		teamId: request.teamId, deploymentId: request.deploymentId, stackId: request.stackId, authorityId: resolved.authorityId ?? row.id, authorityVersion: resolved.authorityVersion ?? Number(row.version),
		environment: request.environment, backendBindingDigest: request.backendBindingDigest, provider: request.provider, connectionRef: request.connectionRef,
		...(request.secretRef ? { secretRef: request.secretRef } : {}),
		credentialProfileId: request.credentialProfileId, capabilities: request.capabilities, purpose: request.purpose, scheme: row.scheme, expiresAt: resolved.expiresAt, values: resolved.values };
}
