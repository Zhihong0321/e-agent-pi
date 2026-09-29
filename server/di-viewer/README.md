# Document Intelligence database viewer

Open **Settings → Database viewer**, the desktop **Database** link, or `/db-viewer/`.
Unlock Settings first with the existing access password.

Adapted from `E:\000\postgres-viewer`. The assets are bundled with this app;
no separate viewer process, proxy token, or new database configuration is needed.
The backend uses the same `getPool()` / `DATABASE_URL` as Document Intelligence.
The table browser lists the `di` schema. SQL defaults to that schema; authenticated
administrators can also query other schemas explicitly.

Queries are wrapped as a single SELECT subquery using the PostgreSQL extended
protocol and run inside a read-only transaction. Results are limited to 1,000 rows,
statements to 15 seconds, and lock waits to 3 seconds. Each connection is rolled
back and discarded afterwards. The viewer is an admin tool, not a tenant-scoped
agent tool; it can display all DI tenants and soft-deleted records.

Validation: `node --test server/di-viewer.test.mjs`. Set `DATABASE_URL` to include
the live PostgreSQL tests (or use `node --env-file=.env --test server/di-viewer.test.mjs`).
