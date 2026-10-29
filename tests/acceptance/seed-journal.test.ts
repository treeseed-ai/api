import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class SeedJournalAcceptance {
  static program(): void {
    const result = spawnSync('node', ['dist/tests/support/seed-journal-program.js'], { encoding: 'utf8', timeout: 30000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('seed-journal-public-ok\n');
    expect(result.stderr).toBe('');
  }
}
test('built native seed journal persists and resumes without activation or original bundle', SeedJournalAcceptance.program);
