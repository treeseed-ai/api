/** Never expose database statements, account identifiers, tokens, or provider bodies. */
export function identityMigrationFailureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '42501') return 'database-permission';
  if (code === '42P01' || code === '42703') return 'database-schema';
  if (code === '23505') return 'database-conflict';
  const message = error instanceof Error ? error.message : '';
  const known: Array<[string,string]> = [
    ['Unsupported existing password verifier; Identity password reset required','password-reset-required'],
    ['Existing account requires Identity recovery before cutover','account-recovery-required'],
    ['Existing accounts require a coordinated restore point before Identity import','restore-point-required'],
    ['Identity account import request failed','issuer-request-failed'],
    ['Identity user-profile policy unavailable','issuer-profile-unavailable'],
    ['Identity user-profile policy read-back failed','issuer-profile-readback'],
    ['Identity migration marker must be administrator-only','issuer-marker-policy'],
    ['Existing Identity account requires explicit account linking','account-link-required'],
    ['Identity account ownership read-back failed','account-ownership-readback'],
    ['Identity account import read-back missing','account-import-readback'],
  ];
  return known.find(([expected])=>message===expected)?.[1] ?? 'unclassified';
}
