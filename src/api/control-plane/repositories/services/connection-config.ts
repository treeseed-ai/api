import { ServiceOperationError } from '../service-operation-error.ts';

/** Provider account configuration is separate from app deployment selection. */
export function cloudflareConnectionConfig(config: Record<string, unknown>, capabilities: any[], existing?: any) {
  const next = {...config};
  const enabled = (type: string) => capabilities.some(c => c.capabilityType === type && c.status !== 'disabled');
  if (enabled('frontend-hosting')) {
    if (!['staging', 'production'].includes(String(next.deploymentEnvironment)))
      throw new ServiceOperationError(400, 'deployment_environment_required', 'Choose a deployment environment for app publishing.');
  } else delete next.deploymentEnvironment;
  // Resolved IDs are provider-verified data, never accepted from the caller.
  delete next.zoneId;
  if (enabled('dns-management')) {
    const domain = String(next.domain ?? '').trim().toLowerCase();
    if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain))
      throw new ServiceOperationError(400, 'domain_required', 'Enter a domain such as example.com, without a URL or path.');
    next.domain = domain;
    if (existing?.domain === domain && existing?.accountId === next.accountId && existing?.zoneId) next.zoneId = existing.zoneId;
  } else delete next.domain;
  return next;
}
