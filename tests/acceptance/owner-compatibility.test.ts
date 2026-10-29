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
      version: '0.0.0-cordis.44',
      commit: '00be028b92998f8d7039a3906e784c6b8598e730',
      sha256: 'd95c54cf6081c7634498dfb4f3235d42d65b8664a5d62cc87c4dd4e85381f0f3',
    },
    deployment: {
      version: '0.0.0-cordis.129',
      commit: 'ec2c24513fcdcd94de17a21ae8350a8138294cbe',
      sha256: 'ba4a51643ac421acfff21d38e069ecff98e49d56c09b0b531bcc063cb427c844',
    },
    identity: {
      version: '0.0.0-cordis.10',
      commit: '1ed37c2384ceb23fba8b0a96ca9abe208a2cb2e5',
      sha256: '3e2e4bd25c21a4be99e927a5431f474be3903fbd509cc617adaf6c4c83183600',
    },
    admin: {
      version: '0.0.0-cordis.13',
      commit: '7fd25302a85722bd642c676231f451bbabb6aec2',
      sha256: 'cc8d32818839b8d1b0265b7b77f5fc76910e1203172644c6dd1cffaa12abc1c1',
    },
    ui: {
      version: '0.0.0-cordis.24',
      commit: 'b4a1490c5b06ba49b4f3408391b236be2400553a',
      sha256: 'ad7be6878932ac76a0b8d81622dd826a5152062185852bf40dc0c6c63d41c4e1',
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
