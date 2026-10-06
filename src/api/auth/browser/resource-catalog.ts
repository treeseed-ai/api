import { OperationRegistry } from '../../control-plane/catalog/operation-registry.ts';

/** Login, credential changes and identity linking belong to the issuer after
 * cutover. Do not advertise retired local writers on the resource server. */
export function identityResourceCatalog(registry: OperationRegistry) {
  const retired = new Set(['accounts.register', 'accounts.email.confirm',
    'accounts.password.reset.request', 'accounts.password.reset.complete', 'accounts.password.update',
    'accounts.emails.create', 'accounts.emails.verify', 'accounts.emails.primary', 'accounts.emails.delete',
    'accounts.providers.unlink', 'accounts.sessions.list', 'accounts.sessions.revoke']);
  return new OperationRegistry([...registry.operations.values()].filter(operation => !retired.has(operation.binding.descriptor.operationId)));
}
