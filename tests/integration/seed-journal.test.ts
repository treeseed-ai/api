import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { InstallationRecords } from '@treeseed-cordis/deployment';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { SeedJournalFixture } from '../support/seed-journal-fixture.js';
class SeedJournalIntegration {
  static async idempotent(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const writer = await fixture.acquire();
      await writer.intent(fixture.plan.resources[0]!);
      await writer.intent(fixture.plan.resources[0]!);
      const receipt = SeedJournalFixture.receipt(fixture.plan);
      expect(await writer.publish(receipt)).toEqual(receipt);
      expect(await writer.publish(receipt)).toEqual(receipt);
      expect(await writer.read()).toEqual({ receipt, intents: ['root'] });
      await writer.close();
      const records = await InstallationRecords.inspect(this.scope(fixture), fixture.signal);
      expect(records.length).toBe(3);
    } finally { await fixture.close(); }
  }
  static scope(fixture: SeedJournalFixture): object {
    return { installationId: fixture.plan.binding.installationId,
      installationDirectory: fixture.release.installation, namespace: 'seeds' };
  }
  static async concurrent(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const writer = await fixture.acquire();
      await expect(fixture.acquire('another-request')).rejects.toThrow('SEED_JOURNAL_BUSY');
      await writer.close();
      const next = await fixture.acquire('another-request');
      expect(await next.read()).toEqual({ receipt: null, intents: [] });
    } finally { await fixture.close(); }
  }
  static async changedRequest(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      await (await fixture.acquire()).close();
      const plan = structuredClone(fixture.plan);
      plan.binding.project = 'different-project';
      const { id: _id, digest: _digest, ...content } = plan;
      plan.digest = CanonicalJson.digest(content);
      plan.id = 'seed-plan-' + plan.digest;
      await expect(fixture.acquire('fixture-request', plan)).rejects.toThrow('SEED_JOURNAL_CONFLICT');
      expect((await (await fixture.acquire()).read()).intents).toEqual([]);
    } finally { await fixture.close(); }
  }
  static async noIntent(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const writer = await fixture.acquire();
      await expect(writer.publish(SeedJournalFixture.receipt(fixture.plan))).rejects.toThrow('SEED_JOURNAL_INVALID');
      await expect(writer.intent(SeedJournalFixture.resource('foreign'))).rejects.toThrow('SEED_JOURNAL_INVALID');
      expect(await writer.read()).toEqual({ receipt: null, intents: [] });
    } finally { await fixture.close(); }
  }
  static async foreignReceipt(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const writer = await fixture.acquire();
      await writer.intent(fixture.plan.resources[0]!);
      const receipt = SeedJournalFixture.receipt(fixture.plan);
      receipt.binding.grantRevision++;
      await expect(writer.publish(receipt)).rejects.toThrow('SEED_JOURNAL_INVALID');
      expect((await writer.read()).receipt).toBeNull();
    } finally { await fixture.close(); }
  }
  static async malformedDomain(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const records = await InstallationRecords.acquire(this.scope(fixture), fixture.signal);
      await records.append(null, { schemaVersion: 'treeseed.seed-journal/v1', kind: 'UNKNOWN_PRIVATE_CANARY' });
      records.close();
      await expect(fixture.acquire()).rejects.toThrow('SEED_JOURNAL_INVALID');
    } finally { await fixture.close(); }
  }
  static async disposal(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const writer = await fixture.acquire();
      await writer.intent(fixture.plan.resources[0]!);
      await fixture.root!.close();
      await expect(writer.read()).rejects.toThrow('SEED_JOURNAL_CLOSED');
      await fixture.open();
      expect((await (await fixture.acquire()).read()).intents).toEqual(['root']);
    } finally { await fixture.close(); }
  }
  static async beforeCustody(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const plan = structuredClone(fixture.plan);
      plan.digest = 'b'.repeat(64);
      await expect(fixture.acquire('fixture-request', plan)).rejects.toThrow('SEED_JOURNAL_INVALID');
      expect(existsSync(fixture.directory)).toBe(false);
    } finally { await fixture.close(); }
  }
  static async recovery(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const writer = await fixture.acquire();
      await writer.intent(fixture.plan.resources[0]!);
      const receipt = SeedJournalFixture.receipt(fixture.plan);
      await writer.publish(receipt);
      receipt.state = 'recovery-required';
      receipt.resources[0]!.state = 'recovery-required';
      receipt.blockers = [{ code: 'OWNER_CHANGED', message: 'Owner read-back changed.' }];
      expect((await writer.publish(receipt)).state).toBe('recovery-required');
    } finally { await fixture.close(); }
  }
  static async snapshot(): Promise<void> {
    const fixture = new SeedJournalFixture();
    try {
      await fixture.prepare();
      const plan = structuredClone(fixture.plan);
      const pending = fixture.acquire('fixture-request', plan);
      plan.binding.project = 'mutated-after-call';
      await (await pending).close();
      expect((await (await fixture.acquire()).read()).intents).toEqual([]);
    } finally { await fixture.close(); }
  }
}
test('private seed progress is idempotent and read back from exact records', SeedJournalIntegration.idempotent);
test('one native journal writer excludes concurrent requests', SeedJournalIntegration.concurrent);
test('a request identity cannot adopt a different exact plan', SeedJournalIntegration.changedRequest);
test('resource intent is required and exact before owner receipt publication', SeedJournalIntegration.noIntent);
test('journal rejects foreign grant and owner receipt bindings', SeedJournalIntegration.foreignReceipt);
test('valid custody containing malformed API records is not silently adopted', SeedJournalIntegration.malformedDomain);
test('native Cordis disposal releases active journal custody', SeedJournalIntegration.disposal);
test('invalid plans create no seed store state', SeedJournalIntegration.beforeCustody);
test('fresh owner drift can record explicit recovery after completion', SeedJournalIntegration.recovery);
test('request plan is snapshotted before asynchronous custody', SeedJournalIntegration.snapshot);
