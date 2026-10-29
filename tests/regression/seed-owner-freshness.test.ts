import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { SeedFixture, SeedData } from '../support/seed-reconciliation-program.js';
class SeedOwnerFreshnessRegression {
  async invalidated(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.owners.beforeEffect = this.invalidate.bind(this, fixture);
    const result = await fixture.apply(this.plan());
    assert.equal(result.state, 'recovery-required');
    assert(!fixture.journal.events.includes('publish:completed'));
    assert.deepEqual(fixture.owners.effects, ['root', 'child']);
  }
  async fresh(): Promise<void> {
    const fixture = new SeedFixture();
    assert.equal((await fixture.apply(this.plan())).state, 'completed');
    const events = fixture.journal.events;
    assert(events.lastIndexOf('read:root') > events.indexOf('intent:child'));
    for (const key of ['root', 'child']) {
      assert.equal(this.count(events, 'intent:' + key), 1);
      assert.equal(this.count(events, 'read:' + key), 2);
    }
    assert.deepEqual(fixture.owners.effects, ['root', 'child']);
  }
  private invalidate(fixture: SeedFixture): void {
    if (fixture.owners.effects.includes('root')) fixture.owners.changedKey = 'root';
  }
  private plan(): ReturnType<typeof SeedData.plan> {
    return SeedData.plan([SeedData.resource('child', ['root']), SeedData.resource('root')]);
  }
  private count(events: string[], expected: string): number {
    let count = 0;
    for (const event of events) if (event === expected) count++;
    return count;
  }
}
const suite = new SeedOwnerFreshnessRegression();
test(
  'regression: later seed effects cannot leave an earlier stale record in a completed aggregate',
  suite.invalidated.bind(suite),
);
test(
  'regression: final seed freshness reads every owner after effects without repeating intents or reconciliation',
  suite.fresh.bind(suite),
);
