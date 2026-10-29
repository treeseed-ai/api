import assert from 'node:assert/strict';
import { SeedJournalFixture } from './seed-journal-fixture.js';
class SeedJournalProgram {
  static async run(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const marker = fixture.marker();
      const writer = await fixture.acquire();
      assert.deepEqual(await writer.read(), { receipt: null, intents: [] });
      await writer.intent(fixture.plan.resources[0]!);
      const receipt = SeedJournalFixture.receipt(fixture.plan);
      assert.deepEqual(await writer.publish(receipt), receipt);
      await writer.close();
      await fixture.restartWithoutBundle();
      const resumed = await fixture.acquire();
      assert.deepEqual(await resumed.read(), { receipt, intents: ['root'] });
      assert.deepEqual(fixture.marker(), marker);
      fixture.permissions();
    } finally { await fixture.close(); }
    process.stdout.write('seed-journal-public-ok\n');
  }
}
if (import.meta.main) await SeedJournalProgram.run();
