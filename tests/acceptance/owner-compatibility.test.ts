import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@treeseed-cordis/sdk';
interface OwnerSelection { version: string; commit: string; sha256: string; }
class ApiOwnerCompatibility {
  private static readonly owners: Record<string, OwnerSelection> = {
    sdk: { version: '0.0.0-cordis.19', commit: '90cf4f3cc62e166685280450c727499defd2af5b',
      sha256: '93dd549c98aba180306e9b19cc1cbc37494544b2764ed341c531c9af618c6f81' },
    deployment: { version: '0.0.0-cordis.79', commit: '2cf1084843039fafccb8e427fcae913e0a44dffc',
      sha256: 'd02517f4fff3a1dedb3590d3c13bb1ea58a746c7ba6fc1f5227fd5f7c3b0a456' },
    identity: { version: '0.0.0-cordis.8', commit: 'cb86258e93337559aa4a248177a20bd2a07fd467',
      sha256: 'a308c71b0da1822e7786121092a05f2496d26614942aaeb459a78531e689cb76' },
    admin: { version: '0.0.0-cordis.11', commit: 'fe5c25e4a15fe9312c16ceeead93b684c3ab8580',
      sha256: '043c05cf734e5b66e60d44fafbff34b15de6af13d98dc14d7a569ba26a51ad97' },
    ui: { version: '0.0.0-cordis.18', commit: 'e2b9c5e10611c196834fd57ba5358a74304e373c',
      sha256: 'd09e6ed33f7f1bc2f7210208a94f33bbd2a6453d8fe886f75a1f950887223e48' },
  };
  run(): void {
    expect(typeof Reflect.get(sdk, 'CapacitySchemas')).toBe('function');
    for (const [owner, selection] of Object.entries(ApiOwnerCompatibility.owners))
      this.selection(owner, selection);
  }
  private selection(owner: string, selection: OwnerSelection): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const installed = JSON.parse(readFileSync('node_modules/@treeseed-cordis/' + owner + '/package.json', 'utf8'));
    const digest = createHash('sha256').update(readFileSync('vendor/' + owner + '.tgz')).digest('hex');
    expect(metadata.peerDependencies['@treeseed-cordis/' + owner]).toBe(selection.version);
    expect(installed.version).toBe(selection.version);
    expect(metadata.cordisCandidate[owner].commit).toBe(selection.commit);
    expect(metadata.cordisCandidate[owner].sha256).toBe(selection.sha256);
    expect(digest).toBe(selection.sha256);
  }
}
const suite = new ApiOwnerCompatibility();
test('acceptance: API peers installed owners and accepted capacity archives agree exactly', suite.run.bind(suite));
