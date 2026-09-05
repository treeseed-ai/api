import { randomUUID } from 'node:crypto';
import { CustodyError } from '@treeseed/deployment/security/custody';
import { canonicalSecretPath, getServiceProviderDefinition } from '@treeseed/sdk/secrets-capability';
import { managedSecretSession, serviceSecretScope, type SecretSession } from '../../../../security/managed-secrets.ts';
import { ServiceOperationError } from '../service-operation-error.ts';
import { validateManagedServiceCredentials } from '@treeseed/deployment/security/services';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;
export function createServiceCredentials(store: any, session: SecretSession = managedSecretSession()) {
  const useCustody: SecretSession = async (scope, run) => {
    try { return await session(scope, run); }
    catch (error) {
      if (error instanceof ServiceOperationError) throw error;
      if (error instanceof CustodyError && ['version_conflict', 'openbao_http_400'].includes(error.code))
        throw new ServiceOperationError(409, 'credential_version_conflict', 'Credentials changed; inspect again.');
      throw new ServiceOperationError(503, 'credential_custody_unavailable', 'Managed credential custody is unavailable.');
    }
  };
  async function access(principal: Principal, teamId: string, connectionId: string, profileId: string) {
    if (!principal) throw new ServiceOperationError(401, 'authentication_required', 'Authentication required.');
    const platformAdmin = principal.roles?.includes('platform_admin') || principal.permissions?.includes('*:*:*');
    if (!platformAdmin && (!await store.principalCanAccessTeam(principal, teamId) || !await store.principalCanManageServices(principal, teamId)))
      throw new ServiceOperationError(403, 'secret_access_denied', 'Service credential administration is required.');
    const connection = await store.getTeamServiceConnection(teamId, connectionId);
    if (!connection || connection.status === 'disconnected') throw new ServiceOperationError(404, 'service_connection_not_found', 'Service connection not found.');
    let scope;
    try { scope = serviceSecretScope(teamId, connection, profileId); }
    catch { throw new ServiceOperationError(400, 'credential_scope_invalid', 'Select a managed credential profile and deployment environment.'); }
    const profile = getServiceProviderDefinition(connection.providerId)!.credentialProfiles.find(p => p.id === profileId)!;
    const capabilities = connection.capabilities.filter((b: any) => b.status === 'configured' && b.credentialProfileId === profileId)
      .map((b: any) => b.capabilityType).filter((c: any) => profile.capabilities.includes(c));
    if (!capabilities.length) throw new ServiceOperationError(409, 'credential_profile_unused', 'Enable a capability for this profile first.');
    return {connection, scope, profile, capabilities};
  }
  const descriptor = (teamId: string, connectionId: string, profileId: string, version: number, fields: string[]) =>
    ({teamId, connectionId, profileId, custody: 'openbao', version, configured: fields.length > 0, fields});
  async function metadata(teamId: string, connectionId: string, profileId: string, reference: string, capabilities: string[], version: number, status: string) {
    const now = new Date().toISOString();
    await store.run(`INSERT INTO provider_credential_authorities
      (id,team_id,connection_id,credential_profile_id,scheme,reference,capabilities_json,status,version,created_at,updated_at)
      VALUES (?,?,?,?,'openbao',?,?,?,?,?,?) ON CONFLICT(connection_id,credential_profile_id) DO UPDATE SET
      scheme='openbao',reference=excluded.reference,capabilities_json=excluded.capabilities_json,status=excluded.status,
      version=excluded.version,updated_at=excluded.updated_at WHERE provider_credential_authorities.version <= excluded.version`,
      [randomUUID(),teamId,connectionId,profileId,reference,JSON.stringify(capabilities),status,version,now,now]);
  }
  return {
    async credentialStatus(principal: Principal, teamId: string, connectionId: string, profileId: string) {
      const {scope,capabilities} = await access(principal, teamId, connectionId, profileId);
      return useCustody(scope, async custody => {
        const record = await custody.read(scope);
        const version = record?.version ?? await custody.version(scope);
        await metadata(teamId,connectionId,profileId,canonicalSecretPath(scope),capabilities,version,record ? 'ready' : 'revoked');
        return descriptor(teamId,connectionId,profileId,record?.version ?? await custody.version(scope),Object.keys(record?.values ?? {}).sort());
      });
    },
    async putCredentials(principal: Principal, teamId: string, connectionId: string, profileId: string, body: any) {
      const {scope,profile,capabilities} = await access(principal,teamId,connectionId,profileId);
      const values = body.values, allowed = profile.fields.filter(f => f.sensitive);
      if (!values || Object.keys(values).some(k => !allowed.some(f => f.key === k)) || allowed.some(f => f.required && !values[f.key]))
        throw new ServiceOperationError(400,'credential_fields_invalid','Supply the exact required credential profile fields.');
      return useCustody(scope, async custody => {
        const version = await custody.write(scope,values,body.expectedVersion);
        await metadata(teamId,connectionId,profileId,canonicalSecretPath(scope),capabilities,version,'ready');
        await store.recordAuditEvent({eventType:'service.credentials.updated',actorType:'user',actorId:principal!.id,
          targetType:'service_connection',targetId:connectionId,data:{teamId,profileId,version}});
        return descriptor(teamId,connectionId,profileId,version,Object.keys(values).sort());
      });
    },
    async deleteCredentials(principal: Principal, teamId: string, connectionId: string, profileId: string, body: any) {
      const {scope,capabilities} = await access(principal,teamId,connectionId,profileId);
      return useCustody(scope, async custody => {
        const version = await custody.version(scope);
        if (version !== body.expectedVersion) throw new ServiceOperationError(409,'credential_version_conflict','Credentials changed; inspect again.');
        await custody.tombstone(scope,version);
        await metadata(teamId,connectionId,profileId,canonicalSecretPath(scope),capabilities,version,'revoked');
        return descriptor(teamId,connectionId,profileId,version,[]);
      });
    },
    async validateCredentials(principal: Principal, teamId: string, connectionId: string, profileId: string, body: any) {
      const {scope,connection} = await access(principal,teamId,connectionId,profileId);
      return useCustody(scope, async custody => {
        const record = await custody.read(scope);
        if (!record || record.version !== body.expectedVersion) throw new ServiceOperationError(409,'credential_version_conflict','Credentials changed; inspect again.');
        await validateManagedServiceCredentials(connection,profileId,record.values);
        return {ok:true};
      });
    },
  };
}
