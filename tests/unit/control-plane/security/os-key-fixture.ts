import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function keyFixture(value='synthetic-test-key-material-not-for-runtime') {
  const file=join(mkdtempSync(join(tmpdir(),'treeseed-api-key-')),'key');
  writeFileSync(file,value,{mode:0o600}); return file;
}
