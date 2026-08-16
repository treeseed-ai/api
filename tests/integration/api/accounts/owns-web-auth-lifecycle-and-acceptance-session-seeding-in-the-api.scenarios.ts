import {
  createTestApp,
  createTestPostgresDatabase,
  createTestStore,
  describe,
  expect,
  it,
  json,
} from "../../../support/api-harness.ts";

describe("web authentication lifecycle", () => {
  it("owns web auth lifecycle and acceptance session seeding in the API", async () => {
    const db = createTestPostgresDatabase();
    const store = createTestStore(db);
    const app = createTestApp({ db, store });
    const password = "TreeSeed-auth-test-123!";
    const resetPassword = "TreeSeed-auth-reset-456!";

    const signup = await json(
      await app.request("/v1/auth/web/sign-up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "api-auth@example.com",
          username: "api-auth-user",
          password,
          name: "API Auth User",
          colorScheme: "cedar",
          themeMode: "dark",
        }),
      }),
    );
    expect(signup.ok).toBe(true);
    expect(signup.payload.confirmationToken).toEqual(expect.any(String));

    const confirmed = await json(
      await app.request("/v1/auth/web/confirm-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: signup.payload.confirmationToken }),
      }),
    );
    expect(confirmed.ok).toBe(true);
    expect(confirmed.payload.accessToken).toEqual(expect.any(String));

    const signin = await json(
      await app.request("/v1/auth/web/sign-in", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "TreeSeed Test Browser/1.0",
          "x-treeseed-client-ip": "203.0.113.9",
        },
        body: JSON.stringify({ email: "api-auth@example.com", password }),
      }),
    );
    expect(signin.ok).toBe(true);

    const sessions = await json(
      await app.request("/v1/auth/web/sessions", {
        headers: { authorization: `Bearer ${signin.payload.accessToken}` },
      }),
    );
    expect(sessions.payload).toContainEqual(
      expect.objectContaining({
        ipAddress: "203.0.113.9",
        userAgent: "TreeSeed Test Browser/1.0",
      }),
    );

    const resetRequest = await json(
      await app.request("/v1/auth/web/password-reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "api-auth@example.com" }),
      }),
    );
    const reset = await json(
      await app.request("/v1/auth/web/password-reset/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: resetRequest.payload.resetToken,
          newPassword: resetPassword,
        }),
      }),
    );
    expect(reset.ok).toBe(true);

    const deletionSession = await json(
      await app.request("/v1/auth/web/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "api-auth@example.com",
          password: resetPassword,
        }),
      }),
    );
    const reauthenticated = await json(
      await app.request("/v1/auth/web/reauthenticate", {
        method: "POST",
        headers: {
          authorization: `Bearer ${deletionSession.payload.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "account_delete",
          password: resetPassword,
        }),
      }),
    );
    const deleted = await json(
      await app.request("/v1/auth/web/account", {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${deletionSession.payload.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          confirmation: "DELETE MY ACCOUNT",
          reauthenticationGrantId: reauthenticated.payload.grantId,
        }),
      }),
    );
    expect(deleted.ok).toBe(true);

    const auditEvents = (
      await store.all("SELECT event_type FROM audit_events WHERE actor_id = ?", [
        confirmed.payload.principal.id,
      ])
    ).map((row) => row.event_type);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        "auth.email.verified",
        "auth.password.reset",
        "account.deleted",
      ]),
    );
  }, 30_000);

  it("seeds an inspectable Agent Lab topology and forensic event", async () => {
    const db = createTestPostgresDatabase();
    const store = createTestStore(db);
    const app = createTestApp({ db, store });
    const namespace = `atlas-${crypto.randomUUID().slice(0, 8)}`;
    const seeded = await json(await app.request("/v1/acceptance/seed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-treeseed-service-id": "web",
        "x-treeseed-service-secret": "web-test-secret",
      },
      body: JSON.stringify({ namespace }),
    }));
    expect(seeded.ok).toBe(true);
    expect(seeded.payload.fixtures).toMatchObject({
      agentClass: { id: expect.any(String) },
      workdayRun: { id: expect.any(String) },
      workdayEvent: { id: expect.any(String) },
    });

    const projectId = seeded.payload.fixtures.project.id;
    const agentClass = await store.first("SELECT * FROM project_agent_classes WHERE project_id = ?", [projectId]);
    expect(agentClass).toMatchObject({ name: "Visual Audit Agent", status: "active" });
    expect(JSON.parse(String(agentClass?.handler_refs_json))).toMatchObject({
      agents: [expect.objectContaining({ slug: "visual-audit-agent", enabled: true })],
    });
    expect(await store.first("SELECT * FROM capacity_workday_runs WHERE id = ?", [seeded.payload.fixtures.workdayRun.id]))
      .toMatchObject({ status: "queued" });
    expect(await store.first("SELECT * FROM capacity_workday_events WHERE id = ?", [seeded.payload.fixtures.workdayEvent.id]))
      .toMatchObject({
        event_type: "acceptance.atlas.ready",
        message: "A validated project agent definition is available for Atlas inspection.",
      });
  }, 30_000);
});
