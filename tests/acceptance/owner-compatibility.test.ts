import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@treeseed-cordis/sdk';
interface OwnerSelection {
  version: string;
  commit: string;
  sha256: string;
}
class ApiOwnerCompatibility {
  private static readonly owners: Record<string, OwnerSelection> = {
    sdk: {
      version: '0.0.0-cordis.42',
      commit: 'afdfac7bdd3c9c1f783362cd1d50324181e1d725',
      sha256: '0ecfe599916fe8ef364fc4b73203c810981f163109fbe71a0dd4c01a9dfb7bbc',
    },
    deployment: {
      version: '0.0.0-cordis.126',
      commit: 'd6695ffa90bff4cf7f0108af00a8a28b242833bc',
      sha256: 'c0d03d85e1dc83921fc1b9d2193b11a5c0fe4f5a5db93d91fcd4fc95eb0e23ca',
    },
    identity: {
      version: '0.0.0-cordis.9',
      commit: 'c60dfdbc53ce78ddee3c2f18ec7f91358878d49c',
      sha256: '2999a78da5c04f6a894c643d49ab3881ff702fb4325d74fec469a4496f034c67',
    },
    admin: {
      version: '0.0.0-cordis.12',
      commit: 'dae3d32083b3ed3f4a65908a78e332cb5a38d0d2',
      sha256: '1ad95ccb6204df57590adc009b17f18670ffccf1146c98dfa165df8ae114f5ac',
    },
    ui: {
      version: '0.0.0-cordis.23',
      commit: 'd5d33c33791fe8b94aada605dba4aa9392559637',
      sha256: '7291d35fe8758fd27b23f663dcf1f254bd915b5ae3569dde8c9a2f443e45a14f',
    },
  };
  run(): void {
    expect(typeof Reflect.get(sdk, 'CapacitySchemas')).toBe('function');
    const channel = Reflect.get(sdk, 'CapacityChannelSchemas');
    expect(typeof channel).toBe('function');
    expect(Reflect.get(channel, 'version')).toBe('1.1.0-cordis.1');
    expect(sdk.PlatformOperations.all.length).toBe(7);
    for (const [owner, selection] of Object.entries(ApiOwnerCompatibility.owners))
      this.selection(owner, selection);
  }
  private selection(owner: string, selection: OwnerSelection): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/' + owner + '/package.json', 'utf8'),
    );
    const digest = createHash('sha256')
      .update(readFileSync('vendor/' + owner + '.tgz'))
      .digest('hex');
    expect(metadata.peerDependencies['@treeseed-cordis/' + owner]).toBe(selection.version);
    expect(installed.version).toBe(selection.version);
    expect(metadata.cordisCandidate[owner].commit).toBe(selection.commit);
    expect(metadata.cordisCandidate[owner].sha256).toBe(selection.sha256);
    expect(digest).toBe(selection.sha256);
  }
}
const suite = new ApiOwnerCompatibility();
test(
  'acceptance: API peers installed owners and accepted capacity archives agree exactly',
  suite.run.bind(suite),
);
