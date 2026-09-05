import type { HostedInfrastructureAuthorityRequest, HostedInfrastructureVaultMaterial } from '@treeseed/deployment/infrastructure/opentofu';
import { canonicalSecretPath } from '@treeseed/sdk/secrets-capability';
import { managedSecretSession, serviceSecretScope, type SecretSession } from '../../security/managed-secrets.ts';

export async function resolveHostedVaultMaterial(input: {store: any; request: HostedInfrastructureAuthorityRequest;
  env?: NodeJS.ProcessEnv; session?: SecretSession}): Promise<HostedInfrastructureVaultMaterial> {
  const r = input.request;
  const row = await input.store.first(`SELECT a.*, c.provider_id FROM provider_credential_authorities a
    JOIN team_service_connections c ON c.id=a.connection_id AND c.team_id=a.team_id
    WHERE a.team_id=? AND (a.connection_id=? OR c.display_name=?) AND c.status='active'
    AND a.credential_profile_id=? AND a.scheme='openbao' AND a.status='ready'`,
    [r.teamId,r.connectionRef,r.connectionRef,r.credentialProfileId]);
  if (!row) throw new Error('Ready managed OpenBao authority is required.');
  const connection = await input.store.getTeamServiceConnection(r.teamId,row.connection_id);
  if (!connection || connection.providerId !== (r.purpose === 'provider' ? r.provider : 'cloudflare')
    || connection.nonSecretConfig?.deploymentEnvironment !== r.environment) throw new Error('Hosted credential environment mismatch.');
  const grants = JSON.parse(row.capabilities_json);
  if (r.capabilities.some(c => !grants.includes(c) || !connection.capabilities.some((b: any) =>
    b.capabilityType === c && b.credentialProfileId === r.credentialProfileId && b.status === 'configured')))
    throw new Error('Hosted credential capability denied.');
  const scope = serviceSecretScope(r.teamId,connection,r.credentialProfileId);
  if (row.reference !== canonicalSecretPath(scope)) throw new Error('Hosted credential scope mismatch.');
  if (r.purpose === 'state-encryption' && connection.nonSecretConfig.stateEncryptionKeyRef !== r.secretRef)
    throw new Error('State encryption reference mismatch.');
  return (input.session ?? managedSecretSession(input.env))(scope, async custody => {
    const record = await custody.read(scope);
    if (!record || record.version !== Number(row.version)) throw new Error('Credential metadata is stale or missing.');
    const values = r.purpose === 'state-encryption' ? {key: record.values.stateEncryptionKey!} : record.values;
    return {schemaVersion:'treeseed.service-credential-material/v1',source:'treeseed-service-credential-vault',
      requestId:r.requestId,teamId:r.teamId,deploymentId:r.deploymentId,stackId:r.stackId,authorityId:row.id,
      authorityVersion:record.version,environment:r.environment,backendBindingDigest:r.backendBindingDigest,
      provider:r.provider,connectionRef:r.connectionRef,...(r.secretRef ? {secretRef:r.secretRef}:{}),
      credentialProfileId:r.credentialProfileId,capabilities:r.capabilities,purpose:r.purpose,scheme:'openbao',
      expiresAt:new Date(Date.now()+60_000).toISOString(),values};
  });
}
