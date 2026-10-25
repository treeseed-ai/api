import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InstalledApiFixture } from './installed-root-fixture.js';
class InstalledApiTests {
    async program(): Promise<void> {
        const fixture = new InstalledApiFixture();
        try {
            await fixture.prepared(); const file = join(fixture.root, 'api-configuration.json'); writeFileSync(file, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/installed-root-program.js', file], { encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
            if (result.status !== 0) throw new Error(result.stderr); expect(result.stderr).toBe('');
            expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, genuineKeycloak: true, nativeApi: true, publicTls: true, unauthenticatedDenied: true, assetsVerified: true, sourceFree: true, retained: true });
        } finally { fixture.close(); }
    }
}
const installedApi = new InstalledApiTests();
test('smoke: genuine packed API default root composes typed database Keycloak and edge with measured assets and retained host state', installedApi.program.bind(installedApi), 600000);
