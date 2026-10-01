Demo user accounts
==================

Database startup creates `users` and `user_sessions` and adds `sessions.user_id`.
Only an empty users table is seeded with username `admin`, password `1234`, role
`admin`, tier `standard`. Restarting never resets account passwords.

Open `/demo` to sign in. Login uses a salted scrypt password hash and a random
HttpOnly, SameSite=Strict cookie; the database stores only the session token hash.
Sessions expire after seven days. Password resets, disabling an account, and role
changes revoke its existing logins. Chat sessions are scoped to their owner.
Existing Settings authentication remains available for the original app APIs.

As an admin, ask the AI, for example:

- “Create user alice with password 5678.”
- “List users.”
- “Reset alice's password to 9876.”
- “Disable alice.”
- “Set alice's tier to premium.”

Orchestrator, Company Onboarding and DB Manager advertise `list_users`,
`create_user` and `update_user`. Calls need both the existing internal MCP
credential and a short-lived capability issued by the host during an authenticated
admin chat turn. Each call rechecks the live login and role. A plain chat claiming
to be admin cannot grant access. The last active admin cannot be demoted or disabled.

Roles currently govern account administration only. `tier` is persisted metadata;
orchestration quotas and feature access by tier are intentionally left for the next
access-level design. Company documents and records remain a shared workspace.

Validation: `node --test server/users.test.mjs` and `npm run build`.
