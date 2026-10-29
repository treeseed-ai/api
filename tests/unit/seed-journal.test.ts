import { test, expect } from 'bun:test';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { SeedJournalFixture, type JournalRoot } from '../support/seed-journal-fixture.js';
class SeedJournalValidation {
  private static getterCalls = 0;
  static async root(): Promise<JournalRoot> {
    return SeedJournalFixture.type().start({
      scopeId: 'api:fixture',
      target: 'api',
      principalId: 'subject:fixture',
      resourceScope: 'fixture',
    });
  }
  static async invalid(input: unknown, requestId: unknown = 'fixture-request'): Promise<void> {
    const root = await this.root();
    try {
      await expect(
        root.journal.acquire(input, requestId, new AbortController().signal),
      ).rejects.toThrow('SEED_JOURNAL_INVALID');
    } finally {
      await root.close();
    }
  }
  static async digest(): Promise<void> {
    const plan = SeedJournalFixture.plan('/fixture/absent', 'fixture');
    plan.seedDigest = 'b'.repeat(64);
    await this.invalid(plan);
  }
  static async blocked(): Promise<void> {
    const plan = SeedJournalFixture.plan('/fixture/absent', 'fixture');
    plan.blockers = [{ code: 'DENIED', message: 'Not allowed.' }];
    const { id: _id, digest: _digest, ...content } = plan;
    plan.digest = CanonicalJson.digest(content);
    plan.id = 'seed-plan-' + plan.digest;
    await this.invalid(plan);
  }
  static async request(): Promise<void> {
    await this.invalid(SeedJournalFixture.plan('/fixture/absent', 'fixture'), '');
  }
  static async getter(): Promise<void> {
    await this.invalid(
      Object.defineProperty({}, 'PRIVATE_CANARY', {
        enumerable: true,
        get: this.throwGetter.bind(this),
      }),
    );
    expect(this.getterCalls).toBe(0);
  }
  static throwGetter(): never {
    this.getterCalls++;
    throw new Error('PRIVATE_GETTER_CANARY');
  }
  static async cycle(): Promise<void> {
    const value: { self?: unknown } = {};
    value.self = value;
    await this.invalid(value);
  }
  static async principal(): Promise<void> {
    await this.invalid(SeedJournalFixture.plan('/fixture/absent', 'foreign'));
  }
  static async oversized(): Promise<void> {
    await this.invalid({ privatePayload: 'S'.repeat(300000) });
  }
  static async cancelled(): Promise<void> {
    const root = await this.root();
    const controller = new AbortController();
    controller.abort(new Error('PRIVATE_CANCEL_CANARY'));
    try {
      await expect(
        root.journal.acquire(
          SeedJournalFixture.plan('/fixture/absent', 'fixture'),
          'request',
          controller.signal,
        ),
      ).rejects.toThrow('SEED_JOURNAL_CANCELLED');
    } finally {
      await root.close();
    }
  }
}
test(
  'seed journal recomputes plan digest before custody',
  SeedJournalValidation.digest.bind(SeedJournalValidation),
);
test(
  'seed journal rejects blocked plans even with matching digest',
  SeedJournalValidation.blocked.bind(SeedJournalValidation),
);
test(
  'seed journal validates SDK request identities',
  SeedJournalValidation.request.bind(SeedJournalValidation),
);
test(
  'seed journal rejects getters without executing private behavior',
  SeedJournalValidation.getter.bind(SeedJournalValidation),
);
test(
  'seed journal rejects cyclic inputs safely',
  SeedJournalValidation.cycle.bind(SeedJournalValidation),
);
test(
  'seed journal preserves trusted composition scope',
  SeedJournalValidation.principal.bind(SeedJournalValidation),
);
test(
  'seed journal bounds input before schema work',
  SeedJournalValidation.oversized.bind(SeedJournalValidation),
);
test(
  'seed journal maps cancellation without exposing its reason',
  SeedJournalValidation.cancelled.bind(SeedJournalValidation),
);
