/** Maintenance-only conversion for the coordinated Identity migration.
 * This does not verify passwords or provide a fallback authentication path.
 * The orchestrator must protect the returned verifier like a credential and
 * remove this migration utility after the existing installation is accepted.
 */
export function prepareIdentityPasswordImport(envelope: unknown): {
  type: 'password'; temporary: false; credentialData: string; secretData: string;
} {
  const fail = () => new Error('Unsupported existing password verifier; Identity password reset required');
  if (typeof envelope !== 'string' || envelope.length > 128) throw fail();
  const match = /^pbkdf2-sha256\$210000\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/u.exec(envelope);
  if (!match) throw fail();
  const saltText = match[1]!, valueText = match[2]!;
  const originalSalt = Buffer.from(saltText, 'base64url'), value = Buffer.from(valueText, 'base64url');
  try {
    if (originalSalt.length !== 16 || originalSalt.toString('base64url') !== saltText
      || value.length !== 32 || value.toString('base64url') !== valueText) throw fail();
    // The old API used the encoded salt STRING as PBKDF2 input, not its decoded
    // random bytes. Keycloak expects base64 of those actual UTF-8 salt bytes.
    // Keycloak derives the key length from the stored hash and upgrades the
    // algorithm/work factor on successful sign-in under its own current policy.
    return { type: 'password', temporary: false,
      credentialData: JSON.stringify({ algorithm: 'pbkdf2-sha256', hashIterations: 210000 }),
      secretData: JSON.stringify({ value: value.toString('base64'), salt: Buffer.from(saltText, 'utf8').toString('base64') }),
    };
  } finally { originalSalt.fill(0); value.fill(0); }
}
