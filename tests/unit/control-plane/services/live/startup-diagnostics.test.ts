import { expect, it } from 'vitest';
import { apiStartupDiagnostic, apiStartupStage } from '../../../../../src/api/support/startup-diagnostics.ts';

it('preserves startup phase without exposing SQL, configuration or credentials', async () => {
  let failure: unknown;
  try { await apiStartupStage('MIGRATIONS', () => { throw new Error('postgresql://secret:password@host/private SQL'); }); }
  catch (error) { failure = error; }
  const diagnostic = apiStartupDiagnostic(failure);
  expect(diagnostic.code).toBe('MIGRATIONS_FAILED');
  expect(JSON.stringify(diagnostic)).not.toMatch(/password|postgresql|private SQL/);
});
it('handles non-errors and rejects uncontrolled diagnostic fields', () => {
  const error = Object.assign(new Error('private'), { code: 'bad code secret', constraint: 'unsafe statement;password' });
  expect(apiStartupDiagnostic(error)).toMatchObject({ code: 'STARTUP_FAILED' });
  expect(apiStartupDiagnostic(error)).not.toHaveProperty('constraint');
  expect(apiStartupDiagnostic('secret')).toMatchObject({ name: 'Error', code: 'STARTUP_FAILED' });
});
it('returns successful synchronous and asynchronous startup values', async () => {
  expect(await apiStartupStage('CONFIG', () => 1)).toBe(1);
  expect(await apiStartupStage('APPLICATION', async () => 2)).toBe(2);
});
