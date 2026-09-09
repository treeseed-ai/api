import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import { identityEndpointSchema } from '@treeseed/sdk/identity';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const names = z.array(z.string().regex(/^[A-Za-z0-9*][A-Za-z0-9:._/*-]{0,127}$/u)).max(128)
  .refine(values => new Set(values).size === values.length).transform(values => [...values].sort());
const registration = z.object({ id: identifier, issuer: identityEndpointSchema, subject: identifier,
  clientId: identifier, displayName: z.string().trim().min(1).max(256), permissions: names, scopes: names }).strict();
export type IdentityWorkloadRegistration = z.input<typeof registration>;
export interface IdentityWorkloadInventory {
  workloads: Array<IdentityWorkloadRegistration & { status: 'active' | 'revoked' }>;
  humans: Array<{ userId: string; issuer: string; subject: string }>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pair = (issuer: string, value: string) => JSON.stringify([issuer, value]);

/** Internal maintenance plan: authenticated Deployment descriptors plus explicit
 * API-owned grants. Never self-enroll from token claims or infer permissions.
 * Existing records are immutable here; rotation/revocation need a separate plan.
 */
export function planIdentityWorkloads(observed: IdentityWorkloadInventory, input: IdentityWorkloadRegistration[]) {
  const workloads = observed.workloads.map(value => ({ ...registration.parse({ id: value.id, issuer: value.issuer,
    subject: value.subject, clientId: value.clientId, displayName: value.displayName,
    permissions: value.permissions, scopes: value.scopes }), status: z.enum(['active', 'revoked']).parse(value.status) }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const humans = observed.humans.map(value => ({ userId: identifier.parse(value.userId), issuer: value.issuer, subject: value.subject }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  const requested = input.map(value => registration.parse(value)).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const humanSubjects = new Set(humans.map(value => pair(value.issuer, value.subject)));
  const humanIds = new Set(humans.map(value => value.userId));
  const ids = new Set<string>(), subjects = new Set<string>(), clients = new Set<string>();
  for (const value of workloads) {
    if (ids.has(value.id) || subjects.has(pair(value.issuer, value.subject)) || clients.has(pair(value.issuer, value.clientId)))
      throw new Error('Conflicting workload inventory');
    ids.add(value.id); subjects.add(pair(value.issuer, value.subject)); clients.add(pair(value.issuer, value.clientId));
  }
  const requestedIds = new Set<string>();
  const operations = requested.map(value => {
    if (requestedIds.has(value.id)) throw new Error('Duplicate requested workload');
    requestedIds.add(value.id);
    if (humanIds.has(value.id) || humanSubjects.has(pair(value.issuer, value.subject))) throw new Error('Workload conflicts with human identity');
    const current = workloads.find(item => item.id === value.id);
    if (current) {
      const { status, ...existing } = current;
      if (status !== 'active' || digest(existing) !== digest(value)) throw new Error('Workload drift or revocation requires a separate plan');
      return { ...value, action: 'noop' as const };
    }
    if (subjects.has(pair(value.issuer, value.subject)) || clients.has(pair(value.issuer, value.clientId)))
      throw new Error('Workload identity or client already bound');
    subjects.add(pair(value.issuer, value.subject)); clients.add(pair(value.issuer, value.clientId));
    return { ...value, action: 'register' as const };
  });
  return { inventoryDigest: digest({ workloads, humans }), requestDigest: digest(requested), operations };
}
