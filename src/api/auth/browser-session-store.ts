import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { encryptedEnvelopeSchema, type EncryptedEnvelopeCodec } from '@treeseed/sdk/security';

const tokensSchema = z.object({
  accessToken: z.string().min(1).max(32768), refreshToken: z.string().min(1).max(32768).optional(),
  idToken: z.string().min(1).max(32768).optional(), resource: z.string().min(1).max(2048),
  accessExpiresAt: z.number().int().positive(),
}).strict();
export type BrowserSessionTokens = z.infer<typeof tokensSchema>;
interface SessionDatabase { transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const handleHash = (value: string) => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error('Invalid browser session handle');
  return digest(value);
};

/** Internal BFF store, never a browser-facing token API. The API handler must
 * authenticate the registered application workload before constructing this
 * client-bound store. Verified Identity exchange supplies the user mapping.
 * Reuses SDK envelope encryption with a separately provisioned session key.
 */
export class BrowserSessionStore {
  constructor(private readonly database: SessionDatabase, private readonly codec: EncryptedEnvelopeCodec,
    private readonly clientId: string) {
    if (!clientId || clientId.length > 256) throw new Error('Registered BFF client required');
  }

  async create(input: { issuer: string; subject: string; userId: string; expiresAt: Date; tokens: BrowserSessionTokens }) {
    const issuer = new URL(input.issuer);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash ||
      !input.subject || input.subject.length > 1024 || !input.userId || !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= Date.now() || input.expiresAt.getTime() > Date.now() + 86400_000) throw new Error('Invalid browser session binding');
    const handle = randomBytes(32).toString('base64url'), hash = handleHash(handle);
    const binding = { clientId: this.clientId, issuer: input.issuer, subject: input.subject, userId: input.userId, hash, expiresAt: input.expiresAt.toISOString() };
    const envelope = this.codec.encrypt(JSON.stringify(tokensSchema.parse(input.tokens)), this.aad(binding, 1));
    await this.database.transaction(async client => {
      const result = await client.query(`INSERT INTO identity_browser_sessions
        (session_hash,client_id,issuer,subject,user_id,envelope,version,expires_at)
        SELECT $1,$2,$3,$4,id,$5::jsonb,1,$6 FROM users WHERE id=$7 AND status='active'
        AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id=users.id AND i.provider=$3 AND i.provider_subject=$4) RETURNING session_hash`,
      [hash, this.clientId, input.issuer, input.subject, JSON.stringify(envelope), input.expiresAt, input.userId]);
      if (result.rowCount !== 1) throw new Error('Active mapped user required');
    });
    return { handle, expiresAt: input.expiresAt };
  }

  /** Serialize refresh-token rotation under a row lock. The callback uses the
   * Identity client's bounded network request; no tokens reach browser output.
   * A timeout/ambiguous exchange requires sign-in again, not a parallel retry.
   */
  async use<T>(handle: string, run: (tokens: BrowserSessionTokens) => Promise<{ result: T; tokens?: BrowserSessionTokens }>): Promise<T | null> {
    const hash = handleHash(handle);
    let exchangeStarted = false;
    try { return await this.database.transaction(async client => {
      await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='15s'");
      const found = await client.query(`SELECT s.* FROM identity_browser_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.session_hash=$1 AND s.client_id=$2 AND s.expires_at>CURRENT_TIMESTAMP AND u.status='active'
        FOR UPDATE OF s`, [hash, this.clientId]);
      const row = found.rows[0]; if (!row) return null;
      const binding = { clientId: this.clientId, issuer: String(row.issuer), subject: String(row.subject), userId: String(row.user_id), hash, expiresAt: new Date(row.expires_at).toISOString() };
      const envelope = encryptedEnvelopeSchema.parse(row.envelope);
      const aad = this.aad(binding, Number(row.version));
      if (JSON.stringify(envelope.aad) !== JSON.stringify(aad)) {
        // Compare fields, not JSON serialization order returned by jsonb.
        if (Object.keys(envelope.aad).length !== Object.keys(aad).length || Object.entries(aad).some(([key, value]) => (envelope.aad as Record<string, unknown>)[key] !== value)) throw new Error('Browser session envelope binding mismatch');
      }
      const tokens = tokensSchema.parse(JSON.parse(this.codec.decrypt(envelope).toString('utf8')));
      exchangeStarted = true;
      const next = await run(tokens);
      if (next.tokens) {
        if (next.tokens.resource !== tokens.resource) throw new Error('Browser session resource cannot change');
        const version = Number(row.version) + 1;
        const encrypted = this.codec.encrypt(JSON.stringify(tokensSchema.parse(next.tokens)), this.aad(binding, version));
        await client.query('UPDATE identity_browser_sessions SET envelope=$1::jsonb,version=$2 WHERE session_hash=$3 AND client_id=$4',
          [JSON.stringify(encrypted), version, hash, this.clientId]);
      }
      return next.result;
    }); } catch {
      if (exchangeStarted) await this.remove(handle);
      throw new Error('Browser session unavailable; sign in again');
    }
  }

  async remove(handle: string) {
    const hash = handleHash(handle);
    await this.database.transaction(async client => { await client.query('DELETE FROM identity_browser_sessions WHERE session_hash=$1 AND client_id=$2', [hash, this.clientId]); });
  }

  private aad(binding: { clientId: string; issuer: string; subject: string; userId: string; hash: string; expiresAt: string }, version: number) {
    return { purpose: 'browser-session', resourceType: 'oidc-session', resourceId: digest(JSON.stringify(binding)),
      sequence: version, schemaVersion: 'treeseed.browser-session/v1' };
  }
}
