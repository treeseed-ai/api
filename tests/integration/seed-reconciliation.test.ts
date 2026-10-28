import { expect, test } from 'bun:test';
import { SeedData, SeedFixture } from '../support/seed-reconciliation-program.js';

class SeedReconciliationBoundaries {
  async dependencyOrder(): Promise<void> {
    const fixture = new SeedFixture();
    const resources = [
      SeedData.resource('z', ['a']),
      SeedData.resource('b'),
      SeedData.resource('a'),
    ];
    expect((await fixture.apply(SeedData.plan(resources))).state).toBe('completed');
    expect(fixture.owners.effects).toEqual(['a', 'b', 'z']);
    expect(fixture.journal.events.indexOf('intent:a')).toBeLessThan(
      fixture.journal.events.indexOf('read:a'),
    );
  }

  async resume(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.owners.loseReply = true;
    const first = await fixture.apply();
    expect(first.state).toBe('recovery-required');
    expect(JSON.stringify(first)).not.toContain('private-owner-secret-canary');
    expect((await fixture.apply()).state).toBe('completed');
    expect(fixture.owners.effects).toEqual(['root']);
    expect(fixture.journal.events).toContain('admit:root:true');
  }

  async changedReadBack(): Promise<void> {
    const fixture = new SeedFixture();
    expect((await fixture.apply()).state).toBe('completed');
    fixture.owners.changed = true;
    expect((await fixture.apply()).state).toBe('recovery-required');
    expect(fixture.owners.effects).toEqual(['root']);
  }

  async deniedAuthority(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.authority.allowed = false;
    await expect(fixture.apply()).rejects.toThrow('SEED_AUTHORITY_BLOCKED');
    expect(fixture.journal.events).toEqual([]);
    expect(fixture.owners.effects).toEqual([]);
  }

  async cancellation(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.controller.abort();
    await expect(fixture.apply()).rejects.toThrow('SEED_CANCELLED');
    expect(fixture.journal.events).toEqual([]);
  }

  async pendingDependency(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.owners.pending = true;
    const plan = SeedData.plan([SeedData.resource('child', ['root']), SeedData.resource('root')]);
    const result = await fixture.apply(plan);
    expect(result.state).toBe('pending');
    expect(result.resources).toHaveLength(1);
    expect(fixture.owners.effects).toEqual(['root']);
  }

  async failedPublication(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.journal.failPublication = true;
    await expect(fixture.apply()).rejects.toThrow('SEED_JOURNAL_FAILED');
    expect(fixture.journal.locked).toBe(false);
    expect(fixture.journal.progress.intents).toEqual(['root']);
  }

  async failedWriterClose(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.journal.failClose = true;
    await expect(fixture.apply()).rejects.toThrow('SEED_JOURNAL_FAILED');
    expect(fixture.journal.progress.receipt?.state).toBe('completed');
  }

  async failedOwnerClose(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.owners.failClose = true;
    expect((await fixture.apply()).state).toBe('recovery-required');
    expect(fixture.journal.progress.receipt?.state).not.toBe('completed');
  }

  async concurrentWriter(): Promise<void> {
    const fixture = new SeedFixture();
    const plan = SeedData.plan();
    const writer = await fixture.journal.acquire(
      plan,
      'request:fixture',
      fixture.controller.signal,
    );
    await expect(fixture.apply()).rejects.toThrow('SEED_JOURNAL_FAILED');
    expect(fixture.owners.effects).toEqual([]);
    await writer.close();
  }

  async foreignCheckpoint(): Promise<void> {
    const fixture = new SeedFixture();
    await fixture.apply();
    fixture.journal.progress.receipt!.binding.project = 'another-project';
    await expect(fixture.apply()).rejects.toThrow('SEED_JOURNAL_FAILED');
    expect(fixture.journal.locked).toBe(false);
    expect(fixture.owners.effects).toEqual(['root']);
  }

  async freshAggregate(): Promise<void> {
    const fixture = new SeedFixture();
    const plan = SeedData.plan([SeedData.resource('child', ['root']), SeedData.resource('root')]);
    await fixture.apply(plan);
    fixture.journal.events.length = 0;
    await fixture.apply(plan);
    const events = fixture.journal.events;
    expect(events.indexOf('publish:completed')).toBeGreaterThan(events.indexOf('read:child'));
    expect(events).toContain('publish:partial');
    expect(fixture.owners.effects).toEqual(['root', 'child']);
  }

  async failedIntent(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.journal.failIntent = true;
    await expect(fixture.apply()).rejects.toThrow('SEED_JOURNAL_FAILED');
    expect(fixture.owners.effects).toEqual([]);
    expect(fixture.journal.progress.receipt).toBeNull();
    expect(fixture.journal.locked).toBe(false);
  }

  async failedAdmission(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.owners.failAdmission = true;
    await expect(fixture.apply()).rejects.toThrow('SEED_OWNER_BLOCKED');
    expect(fixture.owners.effects).toEqual([]);
    expect(fixture.journal.progress.intents).toEqual([]);
    expect(fixture.journal.progress.receipt).toBeNull();
  }
  async publicationMismatch(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.journal.mismatchPublication = true;
    await expect(fixture.apply()).rejects.toThrow('SEED_JOURNAL_FAILED');
    expect(fixture.journal.locked).toBe(false);
  }
}

const suite = new SeedReconciliationBoundaries();
test(
  'integration: seed resources execute in stable dependency order',
  suite.dependencyOrder.bind(suite),
);
test(
  'integration: lost owner replies resume with exact request identity',
  suite.resume.bind(suite),
);
test(
  'integration: repeated apply freshly verifies owner records',
  suite.changedReadBack.bind(suite),
);
test(
  'integration: denied authority creates no seed journal state',
  suite.deniedAuthority.bind(suite),
);
test(
  'integration: cancellation prevents seed state and owner effects',
  suite.cancellation.bind(suite),
);
test(
  'integration: pending resources prevent dependent effects',
  suite.pendingDependency.bind(suite),
);
test(
  'integration: failed receipt publication never reports acceptance',
  suite.failedPublication.bind(suite),
);
test(
  'integration: failed writer release cannot report completion',
  suite.failedWriterClose.bind(suite),
);
test('integration: failed owner disposal records recovery', suite.failedOwnerClose.bind(suite));
test(
  'integration: concurrent seed writers cannot execute owner steps',
  suite.concurrentWriter.bind(suite),
);
test(
  'integration: foreign saved receipts cannot authorize seed resume',
  suite.foreignCheckpoint.bind(suite),
);
test(
  'integration: resumed aggregate completes only after every fresh owner read-back',
  suite.freshAggregate.bind(suite),
);
test(
  'integration: failed seed intent publication prevents owner execution',
  suite.failedIntent.bind(suite),
);
test(
  'integration: owner admission denial creates no intent or receipt',
  suite.failedAdmission.bind(suite),
);
test(
  'integration: seed publication read-back must equal the requested receipt',
  suite.publicationMismatch.bind(suite),
);
