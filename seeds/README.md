# TreeSeed Seeds

Seed manifests define named, declarative market portfolios that can be validated and planned with the Treeseed CLI.

Seed ownership is split across packages:

- `@treeseed/sdk` owns seed schema, validation, normalization, and shared contracts.
- `@treeseed/api` owns backend seed application into Treeseed PostgreSQL/control-plane state.
- `@treeseed/admin` may expose seed, catalog, and portfolio management surfaces.
- root `@treeseed/market` owns tenant content, public catalog messaging, and future marketplace policy.
- TreeDX may store and index repository-backed content, but it does not interpret Treeseed product semantics.

Seed planning is available for every declared environment:

```bash
trsd seed treeseed --environments local --plan
trsd seed treeseed --validate
```

Local apply is implemented through the TreeSeed API control-plane store and is
idempotent:

```bash
trsd seed treeseed --environments local --apply
```

Local apply creates or updates seeded teams, projects, repository hosts,
capacity providers, execution providers, capacity grants, work policies,
products, catalog artifacts, project hosting records, and project repository
bindings. It can attach an existing authenticated or bootstrap user as a
`team_owner`, but seed manifests do not create user accounts.

Production apply is guarded by approval records. A production apply without a
matching approved request creates or returns the approval requirement instead
of mutating resources.

Seed manifests must not store provider or cloud secrets. They may reference
credential locations such as `env:TREESEED_GITHUB_TOKEN`. Local-only
capacity-provider bootstrap may use a deterministic disposable provider API key
through the API key registration flow, but non-local provider connection
material should be generated or configured outside the manifest. Returned seed
run records redact plaintext provider keys; the CLI stores newly-created local
provider connection material in encrypted TreeSeed config.
