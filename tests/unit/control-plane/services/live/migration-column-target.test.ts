import { describe, expect, it } from 'vitest';
import { migrationColumnTarget } from '../../../../../src/api/support/migration-column-target.ts';

describe('migration column guard', () => {
	it.each([
		'ALTER TABLE example DROP COLUMN gone',
		'ALTER TABLE "example" DROP COLUMN "gone"',
		'ALTER TABLE "example" DROP COLUMN IF EXISTS "gone"',
		'ALTER TABLE IF EXISTS "example" DROP COLUMN IF EXISTS "gone"',
		'ALTER TABLE example ALTER COLUMN gone SET NOT NULL',
	])('resolves the real identifier: %s', sql => {
		expect(migrationColumnTarget(sql)).toEqual({ table: 'example', column: 'gone' });
	});
	it('does not treat another migration operation as an existing-column mutation', () => {
		expect(migrationColumnTarget('ALTER TABLE example ADD COLUMN new_column text')).toBeNull();
	});
});
