import { describe, expect, it } from 'vitest';
import { splitPostgresSqlStatements } from '../../src/api/postgres-sql-statements.ts';

describe('PostgreSQL migration statement splitting', () => {
	it('keeps dollar-quoted migration blocks atomic', () => {
		const statements = splitPostgresSqlStatements(`
			ALTER TABLE example ADD COLUMN IF NOT EXISTS owner_id text;
			DO $migration$
			BEGIN
				IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'example_owner_fk') THEN
					ALTER TABLE example
						ADD CONSTRAINT example_owner_fk
						FOREIGN KEY (owner_id) REFERENCES owners (id);
				END IF;
			END
			$migration$;
			CREATE INDEX IF NOT EXISTS example_owner_idx ON example (owner_id);
		`);
		expect(statements).toHaveLength(3);
		expect(statements[1]).toContain('FOREIGN KEY (owner_id)');
		expect(statements[1]).toContain('END IF;');
	});
});
