const ENV_REFERENCE = /^TREESEED_[A-Z0-9]+(?:_[A-Z0-9]+)*$/u;

const profileFor = (provider: string, kind: string) => provider === 'railway'
	? 'railway-workspace'
	: ['dns-record', 'tls-policy'].includes(kind) ? 'cloudflare-dns' : 'cloudflare-runtime';

const capabilityFor = (provider: string, kind: string) => provider === 'railway'
	? kind === 'postgresql' ? 'database-hosting' : kind === 'treedx-service' ? 'private-knowledge-index-hosting' : 'backend-hosting'
	: ['dns-record', 'tls-policy'].includes(kind) ? 'dns-management' : 'frontend-hosting';

export async function resolveHostedProviderAuthority(input: {
	store: any; teamId: string; connectionRef: string; provider: string; kind: string;
	env?: NodeJS.ProcessEnv; externalResolver?: (authority: any) => Promise<string>;
}) {
	const profile = profileFor(input.provider, input.kind), capability = capabilityFor(input.provider, input.kind);
	const row = await input.store.first(`SELECT a.* FROM provider_credential_authorities a
		JOIN team_service_connections c ON c.id = a.connection_id AND c.team_id = a.team_id
		JOIN team_service_capability_bindings b ON b.connection_id = c.id AND b.team_id = c.team_id
			AND b.credential_profile_id = a.credential_profile_id AND b.capability_type = ? AND b.status = 'configured'
		WHERE a.team_id = ? AND a.connection_id = ? AND c.provider_id = ? AND c.status = 'active'
		AND a.credential_profile_id = ? AND a.status = 'ready'`, [capability, input.teamId, input.connectionRef, input.provider, profile]);
	if (!row) throw new Error(`Ready ${profile} authority is required for hosted ${input.kind} reconciliation.`);
	const capabilities = JSON.parse(row.capabilities_json ?? '[]');
	if (!capabilities.includes(capability)) throw new Error(`The ${profile} authority does not grant ${capability}.`);
	let token: string | undefined;
	if (row.scheme === 'environment-reference') {
		if (!ENV_REFERENCE.test(row.reference)) throw new Error('Hosted provider environment authority uses an invalid reference.');
		token = (input.env ?? process.env)[row.reference];
	} else if (['external-vault', 'workload-identity'].includes(row.scheme) && input.externalResolver) token = await input.externalResolver(row);
	else throw new Error(`Hosted provider authority scheme ${row.scheme} is not configured for unattended resolution.`);
	if (!token) throw new Error(`Hosted provider authority ${row.reference} is unavailable.`);
	return { token, profile, capability };
}
