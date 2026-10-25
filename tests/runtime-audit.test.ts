import { test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceReleaseFixture, PreparedReleaseFixture } from '@treeseed-cordis/deployment/testing';
import { PackageArchiveMaterializer } from '@treeseed-cordis/deployment';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { ApiRuntimeAudit } from '../src/runtime-audit.js';
import { ApiBuild } from '../src/server.js';
class RuntimeAuditTests {
    async program(): Promise<void> {
        const fixture = await new ServiceReleaseFixture().services();
        try {
            const source = join(fixture.root, 'plugin/package'); mkdirSync(join(source, 'dist/src'), { recursive: true }); copyFileSync(join(source, 'index.js'), join(source, 'dist/src/server.js'));
            await fixture.saveMetadata({ name: '@treeseed-cordis/api', version: '1.0.0', type: 'module', exports: './dist/src/server.js' });
            const archive = join(fixture.bundle, 'archives/plugin.tgz'), sha256 = PreparedReleaseFixture.sha(readFileSync(archive)), root = join(fixture.root, 'runtime'), target = join(root, 'node_modules/@treeseed-cordis/api');
            mkdirSync(target, { recursive: true, mode: 0o700 }); mkdirSync(join(root, 'archives'), { mode: 0o755 }); await PackageArchiveMaterializer.materialize(archive, sha256, target); copyFileSync(archive, join(root, 'archives', sha256 + '.tgz'));
            const packages = [{ kind: 'package', name: '@treeseed-cordis/api', version: '1.0.0', sha256 }], assetDigest = CanonicalJson.digest([]), packageSetDigest = CanonicalJson.digest(packages), receipt = join(root, 'cordis-runtime.json'), entry = join(target, 'dist/src/server.js'), original = readFileSync(entry), entryDigest = PreparedReleaseFixture.sha(original);
            writeFileSync(receipt, CanonicalJson.stringify({ formatVersion: 2, baseImage: 'node@sha256:' + 'a'.repeat(64), packageDigest: packageSetDigest, assetDigest, packages }) + '\n', { mode: 0o644 });
            const code = "import {ApiRuntimeAudit} from '@treeseed-cordis/api';class Program{static async run(){process.stdout.write(JSON.stringify(await ApiRuntimeAudit.inspect(process.argv[1],process.argv[2]))+'\\n');}}await Program.run();", result = spawnSync('node', ['--input-type=module', '-e', code, receipt, assetDigest], { encoding: 'utf8' });
            expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(JSON.parse(result.stdout)).toEqual({ packageSetDigest, entryDigest }); expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
            writeFileSync(entry, original.toString() + '\n// changed bytes'); await expect(ApiRuntimeAudit.inspect(receipt, assetDigest)).rejects.toThrow(); writeFileSync(entry, original);
            const extra = join(target, 'unexpected.js'); writeFileSync(extra, 'class Unexpected{}'); await expect(ApiRuntimeAudit.inspect(receipt, assetDigest)).rejects.toThrow(); unlinkSync(extra);
            unlinkSync(entry); symlinkSync(join(source, 'dist/src/server.js'), entry); await expect(ApiRuntimeAudit.inspect(receipt, assetDigest)).rejects.toThrow(); unlinkSync(entry); writeFileSync(entry, original, { mode: 0o644 });
            const held = join(root, 'archives', sha256 + '.tgz'), bytes = readFileSync(held); writeFileSync(held, Buffer.from('ARCHIVE_SECRET_CANARY')); let refused = false; try { await ApiRuntimeAudit.inspect(receipt, assetDigest); } catch (error) { refused = true; expect(String(error)).not.toContain('ARCHIVE_SECRET_CANARY'); } expect(refused).toBe(true); writeFileSync(held, bytes);
            expect(await ApiRuntimeAudit.inspect(receipt, assetDigest)).toEqual({ packageSetDigest, entryDigest });
            const context = join(fixture.root, 'image-context'); mkdirSync(context, { mode: 0o700 });
            const prepared = await ApiBuild.imageContext(context, 'node@sha256:' + 'a'.repeat(64), [{ name: '@treeseed-cordis/api', version: '1.0.0', path: archive, sha256 }]);
            expect(prepared).toEqual({ packageDigest: packageSetDigest, assetDigest, entryDigest });
            expect(await ApiRuntimeAudit.inspect(join(context, 'runtime/cordis-runtime.json'), assetDigest)).toEqual({ packageSetDigest, entryDigest });
            expect(readFileSync(join(context, 'Dockerfile'), 'utf8')).toContain('ai.treeseed.cordis.runtime-entry="' + entryDigest + '"');
            expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        } finally { fixture.close(); }
    }
}
const runtimeAudit = new RuntimeAuditTests();
test('smoke: API runtime auditor measures retained archives and installed entry without executing packages and rejects tampering', runtimeAudit.program.bind(runtimeAudit));
