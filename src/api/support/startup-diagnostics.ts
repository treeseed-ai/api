/** Startup must remain diagnosable before HTTP logging exists, without forwarding configuration or SQL. */
export async function apiStartupStage<T>(stage: 'CONFIG' | 'DATABASE' | 'MIGRATIONS' | 'IDENTITY' | 'APPLICATION' | 'CREDENTIAL_SCHEMA', operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (cause) { throw Object.assign(new Error('API startup phase failed', { cause }), { code: `${stage}_FAILED` }); }
}

export function apiStartupDiagnostic(error: unknown) {
  const value = error instanceof Error ? error : new Error('Startup failed');
  const fields = value as Error & { code?: unknown; constraint?: unknown };
  const identifier = (input: unknown) => typeof input === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(input) ? input : undefined;
  const stages = ['loadManagedApiIdentityRuntime', 'createPlatformApiApp', 'ensureControlPlaneCredentialSchema', 'migrate', 'resolveApiConfig'];
  const stage = stages.find(name => value.stack?.includes(name)) ?? 'entrypoint';
  return { event: 'operation.internal-error', operationId: `api.startup.${stage}`, name: identifier(value.cause instanceof Error ? value.cause.name : value.name) ?? 'Error',
    code: identifier(fields.code) ?? 'STARTUP_FAILED', ...(identifier(fields.constraint) ? { constraint: identifier(fields.constraint) } : {}) };
}
