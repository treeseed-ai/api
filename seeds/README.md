# TreeSeed Seeds

Seed manifests define named, declarative market portfolios that can be validated and planned with the Treeseed CLI.

Seed ownership is split across packages:

- `@treeseed/sdk` owns seed schema, validation, normalization, and shared contracts.
- `@treeseed/api` owns backend seed application into Treeseed PostgreSQL/control-plane state.
- `@treeseed/admin` may expose seed, catalog, and portfolio management surfaces.
- root `@treeseed/market` owns tenant content, public catalog messaging, and future marketplace policy.
- TreeDX may store and index repository-backed content, but it does not interpret Treeseed product semantics.

Phase 1 is plan-only:

```bash
trsd seed treeseed --environments local --plan
trsd seed treeseed --validate
```

Apply support is intentionally blocked until local reconciliation upserts land in the next phase.
