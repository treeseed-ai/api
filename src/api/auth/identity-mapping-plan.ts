import { createHash } from 'node:crypto';

export interface IdentityMapping { userId: string; issuer: string; subject: string }
export interface IdentityMappingInventory {
  users: Array<{ id: string; status: string }>;
  mappings: IdentityMapping[];
}

/** Read-only migration planning. Inputs must come from an authenticated import,
 * never from email matching. Applying requires a coordinated database restore point. */
export function planIdentityMappings(inventory: IdentityMappingInventory, requested: IdentityMapping[]) {
  const normalize = (mapping: IdentityMapping): IdentityMapping => {
    const url = new URL(mapping.issuer);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !mapping.subject.trim() || !mapping.userId.trim()) throw new Error('Invalid explicit identity mapping');
    // OIDC issuer identifiers are exact strings; do not normalize trailing slashes.
    return { userId: mapping.userId, issuer: mapping.issuer, subject: mapping.subject };
  };
  const key = (mapping: IdentityMapping) => JSON.stringify([mapping.issuer, mapping.subject]);
  const desired = requested.map(normalize).sort((a, b) => key(a).localeCompare(key(b), 'en'));
  const existing = new Map<string, string>();
  for (const mapping of inventory.mappings) {
    const previous = existing.get(key(mapping));
    if (previous && previous !== mapping.userId) throw new Error('Conflicting identity inventory');
    existing.set(key(mapping), mapping.userId);
  }
  const seen = new Set<string>();
  const operations = desired.map(mapping => {
    if (seen.has(key(mapping))) throw new Error('Duplicate requested identity');
    seen.add(key(mapping));
    const users = inventory.users.filter(user => user.id === mapping.userId);
    if (users.length !== 1 || users[0].status !== 'active') throw new Error('Mapping requires one active existing user');
    const owner = existing.get(key(mapping));
    if (owner !== undefined && owner !== mapping.userId) throw new Error('Identity is already bound to another user');
    return { ...mapping, action: owner === mapping.userId ? 'noop' as const : 'bind' as const };
  });
  // Binds acceptance to the complete observed inventory, including account status.
  const observed = {
    users: [...inventory.users].sort((a, b) => a.id.localeCompare(b.id, 'en')),
    mappings: [...inventory.mappings].sort((a, b) => key(a).localeCompare(key(b), 'en')),
  };
  return { inventoryDigest: createHash('sha256').update(JSON.stringify(observed)).digest('hex'), operations };
}
