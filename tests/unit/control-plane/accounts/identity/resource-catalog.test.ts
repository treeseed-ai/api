import { expect, it } from 'vitest';
import { createApiControlPlaneOperations } from '../../../../../src/api/control-plane/catalog/index.ts';
import { identityResourceCatalog } from '../../../../../src/api/auth/browser/resource-catalog.ts';

it('does not advertise local password/session/identity writers after Identity cutover', () => {
  const service = new Proxy({}, { get: () => async () => ({}) });
  const dependencies = new Proxy({ store: service, capacity: service }, { get: () => service });
  const controlPlaneOperations = createApiControlPlaneOperations(dependencies as Parameters<typeof createApiControlPlaneOperations>[0]);
  const catalog = identityResourceCatalog(controlPlaneOperations);
  for (const id of ['accounts.register', 'accounts.password.update', 'accounts.password.reset.request',
    'accounts.password.reset.complete', 'accounts.email.confirm', 'accounts.emails.create',
    'accounts.providers.unlink', 'accounts.sessions.revoke']) expect(catalog.operations.has(id)).toBe(false);
  for (const id of ['accounts.current.show', 'accounts.preferences.update', 'accounts.profile.public.show'])
    expect(catalog.operations.get(id)).toBe(controlPlaneOperations.operations.get(id));
  expect(controlPlaneOperations.operations.has('accounts.register')).toBe(true);
});
