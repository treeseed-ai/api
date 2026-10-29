import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { Service } from 'cordis';
import {
  CapabilityToken,
  CanonicalJson,
  ProviderV4Schemas,
  SeedSchemas,
  SeedContractBinding,
  type SeedPlan,
  type SeedResourcePlan,
  type SeedReceipt,
} from '@treeseed-cordis/sdk';
import {
  Context,
  CordisComposition,
  type CompositionHandle,
  type ProviderLease,
  type TrustedCompositionContext,
} from '@treeseed-cordis/sdk/runtime';
import {
  InstallationRecords,
  InstallationRecordError,
  type InstallationRecord,
} from '@treeseed-cordis/deployment';
export interface SeedProgress {
  receipt: SeedReceipt | null;
  intents: string[];
}
export interface SeedWriter {
  read(): Promise<SeedProgress>;
  intent(resource: SeedResourcePlan): Promise<void>;
  publish(receipt: SeedReceipt): Promise<SeedReceipt>;
  close(): Promise<void>;
}
export interface SeedJournal {
  acquire(plan: unknown, requestId: unknown, signal: AbortSignal): Promise<SeedWriter>;
}
type JournalCode =
  | 'SEED_JOURNAL_INVALID'
  | 'SEED_JOURNAL_BUSY'
  | 'SEED_JOURNAL_CONFLICT'
  | 'SEED_JOURNAL_CANCELLED'
  | 'SEED_JOURNAL_CLOSED'
  | 'SEED_JOURNAL_FAILED';
export class SeedJournalError extends Error {
  constructor(readonly code: JournalCode) {
    super(code);
    this.name = 'SeedJournalError';
  }
  static require(value: unknown, code: JournalCode = 'SEED_JOURNAL_INVALID'): asserts value {
    if (!value) throw new SeedJournalError(code);
  }
  static safe(error: unknown): SeedJournalError {
    if (error instanceof SeedJournalError) return new SeedJournalError(error.code);
    if (error instanceof InstallationRecordError) {
      if (error.code === 'INSTALLATION_RECORDS_BUSY')
        return new SeedJournalError('SEED_JOURNAL_BUSY');
      if (error.code === 'INSTALLATION_RECORDS_CANCELLED')
        return new SeedJournalError('SEED_JOURNAL_CANCELLED');
    }
    return new SeedJournalError('SEED_JOURNAL_FAILED');
  }
}
const Check: typeof SeedJournalError = SeedJournalError;
/** Copy inert JSON before schema parsing or awaiting custody; never invoke input accessors. */
class JournalValue {
  private readonly ancestors = new Set<object>();
  private nodes = 0;
  private bytes = 0;
  static copy(input: unknown): unknown {
    try {
      const value = new JournalValue().copy(input);
      Check.require(Buffer.byteLength(CanonicalJson.stringify(value)) <= 256 * 1024);
      return value;
    } catch {
      throw new SeedJournalError('SEED_JOURNAL_INVALID');
    }
  }
  private copy(value: unknown, depth = 0): unknown {
    Check.require(depth <= 64 && ++this.nodes <= 8192);
    if (typeof value === 'string') {
      this.budget(value);
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      Check.require(Number.isFinite(value));
      return value;
    }
    Check.require(value && typeof value === 'object' && !this.ancestors.has(value));
    this.ancestors.add(value);
    try {
      return Array.isArray(value) ? this.array(value, depth) : this.object(value, depth);
    } finally {
      this.ancestors.delete(value);
    }
  }
  private budget(value: string): void {
    this.bytes += Buffer.byteLength(value);
    Check.require(this.bytes <= 256 * 1024);
  }
  private array(value: unknown[], depth: number): unknown[] {
    Check.require(value.length <= 8192 && Reflect.ownKeys(value).length === value.length + 1);
    const result = [];
    for (let index = 0; index < value.length; index++)
      result.push(this.copy(this.field(value, String(index)), depth + 1));
    return result;
  }
  private object(value: object, depth: number): Record<string, unknown> {
    Check.require(
      Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    );
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      Check.require(
        typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key),
      );
      this.budget(key);
      result[key] = this.copy(this.field(value, key), depth + 1);
    }
    return result;
  }
  private field(value: object, key: string): unknown {
    const field = Object.getOwnPropertyDescriptor(value, key);
    Check.require(field?.enumerable && Object.hasOwn(field, 'value'));
    return field.value;
  }
}
class JournalInput {
  static plan(input: unknown): SeedPlan {
    const result = SeedSchemas.plan.safeParse(JournalValue.copy(input));
    Check.require(result.success);
    const { id, digest, ...content } = result.data;
    Check.require(id === 'seed-plan-' + digest && CanonicalJson.digest(content) === digest);
    return result.data;
  }
  static request(input: unknown): string {
    const result = SeedSchemas.receipt.shape.requestId.safeParse(JournalValue.copy(input));
    Check.require(result.success);
    return result.data;
  }
  static resource(plan: SeedPlan, input: unknown): SeedResourcePlan {
    const result = SeedSchemas.resourcePlan.safeParse(JournalValue.copy(input));
    Check.require(result.success);
    for (const resource of plan.resources)
      if (CanonicalJson.stringify(resource) === CanonicalJson.stringify(result.data))
        return result.data;
    throw new SeedJournalError('SEED_JOURNAL_INVALID');
  }
  static receipt(plan: SeedPlan, requestId: string, input: unknown): SeedReceipt {
    try {
      const receipt = SeedContractBinding.assertReceipt(JournalValue.copy(input), plan);
      Check.require(receipt.requestId === requestId);
      return receipt;
    } catch {
      throw new SeedJournalError('SEED_JOURNAL_INVALID');
    }
  }
  static same(left: unknown, right: unknown): boolean {
    return CanonicalJson.stringify(left) === CanonicalJson.stringify(right);
  }
  static event(requestId: string, kind: JournalEvent['kind'], value: unknown): JournalEvent {
    const field = kind === 'request' ? 'plan' : kind === 'intent' ? 'resource' : 'receipt';
    return JournalValue.copy({
      schemaVersion: 'treeseed.seed-journal/v1',
      kind,
      requestId,
      [field]: value,
    }) as JournalEvent;
  }
  static scope(plan: SeedPlan): {
    installationId: string;
    installationDirectory: string;
    namespace: string;
  } {
    return {
      installationId: plan.binding.installationId,
      installationDirectory: plan.binding.installationDirectory,
      namespace: 'seeds',
    };
  }
}
interface JournalEvent {
  schemaVersion: 'treeseed.seed-journal/v1';
  kind: 'request' | 'intent' | 'receipt';
  requestId: string;
  plan?: SeedPlan;
  resource?: SeedResourcePlan;
  receipt?: SeedReceipt;
}
class JournalRequest {
  readonly intents = new Set<string>();
  receipt: SeedReceipt | null = null;
  constructor(
    readonly plan: SeedPlan,
    readonly requestId: string,
  ) {}
  intent(input: unknown): void {
    this.intents.add(JournalInput.resource(this.plan, input).key);
  }
  publish(input: unknown): void {
    const receipt = JournalInput.receipt(this.plan, this.requestId, input);
    for (const resource of receipt.resources) Check.require(this.intents.has(resource.key));
    this.receipt = receipt;
  }
  progress(): SeedProgress {
    return structuredClone({ receipt: this.receipt, intents: [...this.intents] });
  }
}
/** Replay every API record, including other requests; Deployment already verifies the hash chain. */
class JournalReplay {
  private readonly requests = new Map<string, JournalRequest>();
  constructor(private readonly scope: ReturnType<typeof JournalInput.scope>) {}
  read(records: readonly InstallationRecord[]): this {
    for (const record of records) this.apply(this.event(record.content));
    return this;
  }
  get(requestId: string): JournalRequest | undefined {
    return this.requests.get(requestId);
  }
  private event(input: unknown): JournalEvent {
    const value = JournalValue.copy(input) as Record<string, unknown>;
    Check.require(value && typeof value === 'object' && !Array.isArray(value));
    Check.require(value.schemaVersion === 'treeseed.seed-journal/v1');
    const field =
      value.kind === 'request' ? 'plan' : value.kind === 'intent' ? 'resource' : 'receipt';
    Check.require(['request', 'intent', 'receipt'].includes(value.kind as string));
    Check.require(
      JournalInput.same(
        Object.keys(value).sort(),
        ['schemaVersion', 'kind', 'requestId', field].sort(),
      ),
    );
    JournalInput.request(value.requestId);
    return value as unknown as JournalEvent;
  }
  private apply(event: JournalEvent): void {
    if (event.kind === 'request') {
      this.initialize(event);
      return;
    }
    const request = this.requests.get(event.requestId);
    Check.require(request);
    if (event.kind === 'intent') request.intent(event.resource);
    else request.publish(event.receipt);
  }
  private initialize(event: JournalEvent): void {
    Check.require(!this.requests.has(event.requestId));
    const plan = JournalInput.plan(event.plan);
    Check.require(JournalInput.same(JournalInput.scope(plan), this.scope));
    this.requests.set(event.requestId, new JournalRequest(plan, event.requestId));
  }
}
class InstallationSeedWriter implements SeedWriter {
  private busy = false;
  private closed = false;
  private closeFailed = false;
  private head: string | null = null;
  constructor(
    private readonly records: InstallationRecords,
    private readonly plan: SeedPlan,
    private readonly requestId: string,
    private readonly owner: InstallationSeedJournal,
  ) {}
  async initialize(): Promise<void> {
    const request = await this.current();
    if (request) Check.require(JournalInput.same(request.plan, this.plan), 'SEED_JOURNAL_CONFLICT');
    else await this.append(JournalInput.event(this.requestId, 'request', this.plan));
  }
  private enter(): void {
    Check.require(!this.closed, 'SEED_JOURNAL_CLOSED');
    Check.require(!this.busy, 'SEED_JOURNAL_BUSY');
    this.busy = true;
  }
  private async current(): Promise<JournalRequest | undefined> {
    const records = await this.records.read();
    const replay = new JournalReplay(JournalInput.scope(this.plan)).read(records);
    this.head = records.at(-1)?.digest ?? null;
    return replay.get(this.requestId);
  }
  private async append(event: JournalEvent): Promise<void> {
    await this.records.append(this.head, JournalValue.copy(event));
    await this.current();
  }
  async read(): Promise<SeedProgress> {
    this.enter();
    try {
      const request = await this.current();
      Check.require(request);
      return request.progress();
    } catch (error) {
      throw Check.safe(error);
    } finally {
      this.busy = false;
    }
  }
  async intent(input: SeedResourcePlan): Promise<void> {
    this.enter();
    try {
      const resource = JournalInput.resource(this.plan, input);
      const request = await this.current();
      Check.require(request);
      if (request.intents.has(resource.key)) return;
      await this.append({
        schemaVersion: 'treeseed.seed-journal/v1',
        kind: 'intent',
        requestId: this.requestId,
        resource,
      });
    } catch (error) {
      throw Check.safe(error);
    } finally {
      this.busy = false;
    }
  }
  async publish(input: SeedReceipt): Promise<SeedReceipt> {
    this.enter();
    try {
      const receipt = JournalInput.receipt(this.plan, this.requestId, input);
      await this.recordReceipt(receipt);
      const saved = await this.current();
      Check.require(saved?.receipt && JournalInput.same(saved.receipt, receipt));
      return structuredClone(saved.receipt);
    } catch (error) {
      throw Check.safe(error);
    } finally {
      this.busy = false;
    }
  }
  private async recordReceipt(receipt: SeedReceipt): Promise<void> {
    const request = await this.current();
    Check.require(request);
    const prior = request.receipt;
    request.publish(receipt);
    if (!JournalInput.same(prior, receipt))
      await this.append({
        schemaVersion: 'treeseed.seed-journal/v1',
        kind: 'receipt',
        requestId: this.requestId,
        receipt,
      });
  }
  async close(): Promise<void> {
    Check.require(!this.busy, 'SEED_JOURNAL_BUSY');
    if (!this.closed) {
      this.closed = true;
      try {
        this.records.close();
        this.owner.released(this);
      } catch {
        this.closeFailed = true;
      }
    }
    Check.require(!this.closeFailed, 'SEED_JOURNAL_FAILED');
  }
}
class InstallationSeedJournal implements SeedJournal {
  private readonly writers = new Set<InstallationSeedWriter>();
  private readonly cancellation = new AbortController();
  private closed = false;
  private pending = 0;
  private closeFailed = false;
  constructor(private readonly authority: TrustedCompositionContext) {}
  async acquire(input: unknown, requestInput: unknown, signal: AbortSignal): Promise<SeedWriter> {
    const { plan, requestId } = this.admit(input, requestInput, signal);
    this.pending++;
    try {
      return await this.writer(
        plan,
        requestId,
        AbortSignal.any([signal, this.cancellation.signal]),
      );
    } catch (error) {
      throw Check.safe(error);
    } finally {
      this.pending--;
    }
  }
  private admit(input: unknown, requestInput: unknown, signal: AbortSignal) {
    Check.require(!this.closed, 'SEED_JOURNAL_CLOSED');
    Check.require(signal instanceof AbortSignal);
    Check.require(!signal.aborted, 'SEED_JOURNAL_CANCELLED');
    const plan = JournalInput.plan(input),
      requestId = JournalInput.request(requestInput);
    Check.require(
      plan.binding.principalId === this.authority.principalId &&
        plan.binding.resourceScope === this.authority.resourceScope,
    );
    JournalInput.event(requestId, 'request', plan);
    return { plan, requestId };
  }
  private async writer(
    plan: SeedPlan,
    requestId: string,
    signal: AbortSignal,
  ): Promise<SeedWriter> {
    const records = await InstallationRecords.acquire(JournalInput.scope(plan), signal);
    const writer = new InstallationSeedWriter(records, plan, requestId, this);
    try {
      await writer.initialize();
      Check.require(!this.closed, 'SEED_JOURNAL_CLOSED');
      this.writers.add(writer);
      return writer;
    } catch (error) {
      await writer.close();
      throw error;
    }
  }
  released(writer: InstallationSeedWriter): void {
    this.writers.delete(writer);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancellation.abort();
    while (this.pending) await turn();
    for (const writer of this.writers) {
      try {
        await writer.close();
      } catch {
        this.closeFailed = true;
      }
    }
    Check.require(!this.closeFailed, 'SEED_JOURNAL_FAILED');
  }
}
class JournalAdapter {
  parse(input: unknown): SeedJournal {
    Check.require(
      input && typeof input === 'object' && typeof Reflect.get(input, 'acquire') === 'function',
    );
    return input as SeedJournal;
  }
}
export const SeedJournalToken = new CapabilityToken<SeedJournal>(
  'seed.journal',
  ProviderV4Schemas.version,
  new JournalAdapter(),
);
export class SeedJournalPlugin {
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'installation-seed-journal',
    pluginId: 'api',
    capability: SeedJournalToken.id,
    contractVersion: ProviderV4Schemas.version,
    target: 'api',
    provide: [SeedJournalToken.id],
    inject: ['cordis.composition'],
  });
  static readonly provide = this.declaration.provide;
  static readonly inject = this.declaration.inject;
  static readonly Config = SeedSchemas.binding.pick({});
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  private readonly journal: InstallationSeedJournal;
  constructor(private readonly context: Context) {
    const handle = Reflect.get(context, 'cordis.composition') as CompositionHandle;
    this.journal = new InstallationSeedJournal(handle.authority);
  }
  [Service.init](): () => Promise<void> {
    this.context.provide(SeedJournalToken.id, this.journal);
    return this.journal.close.bind(this.journal);
  }
}
class JournalConsumer {
  static readonly inject = ['cordis.composition', SeedJournalToken.id];
  constructor(context: Context, receiver: { context: Context | null }) {
    receiver.context = context;
  }
}
export class SeedJournalComposition implements SeedJournal {
  private readonly cancellation = new AbortController();
  private closing: Promise<void> | null = null;
  private constructor(
    private readonly handle: CompositionHandle,
    private readonly lease: ProviderLease<SeedJournal>,
  ) {}
  static async start(authority: TrustedCompositionContext): Promise<SeedJournalComposition> {
    let handle: CompositionHandle | null = null;
    try {
      Check.require(authority.target === 'api');
      handle = await CordisComposition.start(this.descriptor(authority.scopeId), authority);
      const lease = await this.consumer(handle);
      return new SeedJournalComposition(handle, lease);
    } catch (error) {
      try {
        await handle?.dispose();
      } catch {
        throw new SeedJournalError('SEED_JOURNAL_FAILED');
      }
      throw Check.safe(error);
    }
  }
  private static async consumer(handle: CompositionHandle): Promise<ProviderLease<SeedJournal>> {
    const receiver: { context: Context | null } = { context: null };
    await handle.mount(JournalConsumer, receiver);
    Check.require(receiver.context);
    return handle.locator(receiver.context).acquire(SeedJournalToken);
  }
  private static descriptor(scopeId: string) {
    return {
      registrations: [this.registration()],
      selections: [
        { scopeId, capability: SeedJournalToken.id, providerId: SeedJournalPlugin.declaration.id },
      ],
    };
  }
  private static registration() {
    const digest = createHash('sha256')
      .update(readFileSync(new URL(import.meta.url)))
      .digest('hex');
    return {
      token: SeedJournalToken,
      declaration: SeedJournalPlugin.declaration,
      plugin: SeedJournalPlugin,
      configuration: {},
      artifact: { kind: 'bundled' as const, identity: 'sha256:' + digest },
    };
  }
  get journal(): SeedJournal {
    return this;
  }
  async acquire(plan: unknown, requestId: unknown, signal: AbortSignal): Promise<SeedWriter> {
    Check.require(!this.closing, 'SEED_JOURNAL_CLOSED');
    try {
      Check.require(signal instanceof AbortSignal);
      return await this.lease.value.acquire(
        plan,
        requestId,
        AbortSignal.any([signal, this.cancellation.signal]),
      );
    } catch (error) {
      throw Check.safe(error);
    }
  }
  close(): Promise<void> {
    this.cancellation.abort();
    this.closing ??= this.dispose();
    return this.closing;
  }
  private async dispose(): Promise<void> {
    let failed = false;
    try {
      await this.lease.release();
    } catch {
      failed = true;
    }
    try {
      await this.handle.dispose();
    } catch {
      failed = true;
    }
    Check.require(!failed, 'SEED_JOURNAL_FAILED');
  }
}
