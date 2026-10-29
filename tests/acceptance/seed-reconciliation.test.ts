import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

class SeedReconciliationProgramTest {
  lateChange(): void {
    const result = spawnSync(
      'node',
      ['dist/tests/support/seed-reconciliation-program.js', 'late-change'],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('seed-late-owner-change-fixture-ok\n');
  }
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/seed-reconciliation-program.js'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('seed-reconciliation-fixture-ok\n');
  }
}

const suite = new SeedReconciliationProgramTest();
test(
  'acceptance: built seed reconciliation component preserves exact resumable owner receipts',
  suite.run.bind(suite),
);
test(
  'acceptance: built seed reconciliation refuses completion after a later effect invalidates an earlier owner',
  suite.lateChange.bind(suite),
);
