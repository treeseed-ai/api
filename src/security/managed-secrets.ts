import { canonicalSecretPath, getServiceProviderDefinition, type SecretScope } from '@treeseed/sdk/secrets-capability';
import { withManagedOpenBao, type OpenBaoCustody } from '@treeseed/deployment/security/custody';

export function serviceSecretScope(teamId: string, connection: any, profileId: string): SecretScope {
  if (connection.teamId !== teamId) throw new Error('Secret connection team mismatch.');
  const profile = getServiceProviderDefinition(connection.providerId)?.credentialProfiles.find(p => p.id === profileId);
  if (!profile?.authoritySchemes?.includes('openbao')) throw new Error('Credential profile does not use managed custody.');
  const environment = connection.providerId === 'github' ? 'shared' : connection.nonSecretConfig?.deploymentEnvironment;
  if (connection.providerId !== 'github' && !['staging', 'production'].includes(environment)) throw new Error('Connection deployment environment is required.');
  const scope = { team: teamId, project: 'team', environment, purpose: profileId, name: connection.id };
  canonicalSecretPath(scope);
  return scope;
}

export type SecretSession = <T>(scope: SecretScope, run: (custody: OpenBaoCustody) => Promise<T>) => Promise<T>;
export async function managedSecretHealth(env:NodeJS.ProcessEnv=process.env,fetchImpl:typeof fetch=fetch):Promise<boolean> {
  try {
    if(!env.TREESEED_OPENBAO_ADDRESS||!env.TREESEED_OPENBAO_IDENTITY_FILE)return false;
    const url=new URL(env.TREESEED_OPENBAO_ADDRESS);
    if(url.protocol!=='https:'||url.username||url.password)return false;
    url.pathname='/v1/sys/health';url.search='';url.hash='';
    const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(3000)});
    await response.body?.cancel();return response.status===200;
  } catch{return false;}
}
export function managedSecretSession(env: NodeJS.ProcessEnv = process.env): SecretSession {
  return (scope, run) => {
    if (!env.TREESEED_OPENBAO_ADDRESS || !env.TREESEED_OPENBAO_IDENTITY_FILE) throw new Error('Core OpenBao is not configured.');
    return withManagedOpenBao({ address: env.TREESEED_OPENBAO_ADDRESS, mount: 'treeseed', identityFile: env.TREESEED_OPENBAO_IDENTITY_FILE }, [scope], run);
  };
}

/** Internal only: callers must authorize the team/operation before requesting material. */
export async function readServiceCredentials(store: any, teamId: string, connectionId: string, profileId: string,
  session: SecretSession = managedSecretSession()) {
  const connection = await store.getTeamServiceConnection(teamId, connectionId);
  if (!connection || connection.status !== 'active') throw new Error('Active service connection required.');
  const scope = serviceSecretScope(teamId, connection, profileId);
  return session(scope, async custody => {
    const record = await custody.read(scope);
    if (!record) throw new Error('Managed credentials are not configured.');
    return record;
  });
}
