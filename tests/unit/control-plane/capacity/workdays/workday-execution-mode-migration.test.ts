import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('uses the PostgreSQL JSON existence function instead of the placeholder-like operator', () => {
	const migration = readFileSync('drizzle/control-plane/0031_workday_execution_mode_authority.sql', 'utf8');
	expect(migration).toContain('jsonb_exists("parameters_json"::jsonb, \'executionMode\')');
	expect(migration).not.toMatch(/::jsonb\s*\?/u);
});
