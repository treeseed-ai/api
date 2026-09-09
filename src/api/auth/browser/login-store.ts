import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { encryptedEnvelopeSchema, type EncryptedEnvelopeCodec } from '@treeseed/sdk/security';
import type { LoginTransaction, LoginTransactionStore } from '@treeseed/identity';

interface Database { transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> }
const identifier = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const transactionSchema = z.object({ state: identifier, nonce: identifier, verifier: identifier,
  expiresAt: z.number().int().positive(), issuer: z.string().url(), clientId: z.string().min(1), redirectUri: z.string().url(),
  resource: z.string().url(), scopes: z.array(z.string()) }).strict();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** API-backed one-shot PKCE state; never persist the verifier or browser handle
 * in plaintext. The configured BFF client owns a separate transaction namespace. */
export class BrowserLoginStore implements LoginTransactionStore {
  constructor(private readonly database: Database, private readonly codec: EncryptedEnvelopeCodec, private readonly clientId: string) {
    if (!clientId || clientId.length > 256) throw new Error('Registered browser client required');
  }
  private aad(browserHash: string, stateHash: string, expiresAt: string) {
    return { purpose: 'browser-login', resourceType: 'oidc-transaction',
      resourceId: digest(JSON.stringify([this.clientId, browserHash, stateHash, expiresAt])), sequence: 1, schemaVersion: 'treeseed.browser-login/v1' };
  }
  async put(browserBinding: string, value: LoginTransaction) {
    try {
      const browserHash = digest(identifier.parse(browserBinding)), transaction = transactionSchema.parse(value);
      if (transaction.clientId !== this.clientId || transaction.expiresAt <= Date.now() || transaction.expiresAt > Date.now() + 300_000) throw new Error();
      const stateHash = digest(transaction.state), expiresAt = new Date(transaction.expiresAt).toISOString();
      const envelope = this.codec.encrypt(JSON.stringify(transaction), this.aad(browserHash, stateHash, expiresAt));
      await this.database.transaction(async client => {
        await client.query('DELETE FROM identity_login_transactions WHERE client_id=$1 AND expires_at<=CURRENT_TIMESTAMP', [this.clientId]);
        await client.query(`INSERT INTO identity_login_transactions(client_id,browser_hash,state_hash,envelope,expires_at)
          VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(client_id,browser_hash)
          DO UPDATE SET state_hash=EXCLUDED.state_hash,envelope=EXCLUDED.envelope,expires_at=EXCLUDED.expires_at`,
        [this.clientId, browserHash, stateHash, JSON.stringify(envelope), expiresAt]);
      });
    } catch { throw new Error('Browser sign-in transaction unavailable'); }
  }
  async consume(browserBinding: string, state: string): Promise<LoginTransaction | null> {
    try {
      const browserHash = digest(identifier.parse(browserBinding)), stateHash = digest(identifier.parse(state));
      // Commit deletion before any decode/exchange. Even a corrupted record
      // cannot be replayed; callback failures require starting sign-in again.
      const row = await this.database.transaction(async client => (await client.query(
        'DELETE FROM identity_login_transactions WHERE client_id=$1 AND browser_hash=$2 AND state_hash=$3 RETURNING envelope,expires_at',
        [this.clientId, browserHash, stateHash])).rows[0]);
      if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
      const expected = this.aad(browserHash, stateHash, new Date(row.expires_at).toISOString()), envelope = encryptedEnvelopeSchema.parse(row.envelope);
      if (Object.keys(envelope.aad).length !== Object.keys(expected).length || Object.entries(expected).some(([key,value]) => (envelope.aad as Record<string,unknown>)[key] !== value)) throw new Error();
      const value = transactionSchema.parse(JSON.parse(this.codec.decrypt(envelope).toString('utf8')));
      if (value.clientId !== this.clientId || value.state !== state || value.expiresAt !== new Date(row.expires_at).getTime()) throw new Error();
      return value;
    } catch { throw new Error('Browser sign-in transaction unavailable'); }
  }
}
