# Company onboarding

The Company Onboarding agent (`di-onboarding`) is registered by the DI host on boot.
Migration `003_company_profile.sql` moves legacy company values into the canonical
`di.company_profile` table. Each newly inserted tenant receives its own profile.
Tenant `name` remains a workspace label; document headers read the profile.

The authenticated manual form is `/company-profile/`, linked from Settings.
It and the agent share field definitions, validation and computed readiness.
Minimum setup requires company name, country, business type, business activity,
currency and either email or phone. Extracted values need user confirmation.
Edits increment a revision; stale manual/agent saves are rejected.

The orchestrator receives current readiness every turn and can refresh it with
`get_company_setup`. Operational DI dispatch is blocked until minimum setup is
ready; onboarding, database and template specialists remain available. This gate
does not replace the existing document-specific issue checks.

## Reset

The agent provides a link; only the authenticated owner form executes reset.
Preview displays counts and an exact tenant-specific confirmation phrase. The
backend rejects a preview if business data changed, takes an owner-only database
snapshot, and clears records in a locked transaction. Failures roll back the
snapshot, deletions and trigger changes together. Schema, custom-field definitions,
tenant identity and audit history remain. Templates, tax codes and workflows can
be kept or restored to defaults. Numbering and company profile values reset.

Snapshots are in `di.reset_backup`; restoration currently requires a database
administrator (no restore UI). Uploaded files and generated PDFs remain on disk
for recovery; reset removes their record links, not the physical files. Existing
chat transcripts also remain; the orchestrator's live profile status supersedes
old setup context. This is not a secure-erasure operation.

## Deployment and limitations

Deploy host code and migration together, then restart the host. The migration is
automatic on boot; it does not reset business data. Back up the database before
deployment because legacy tenant profile columns are moved to the new table.
The host currently selects its default tenant: this change creates profiles for
every tenant but does not add user-to-tenant authentication or tenant switching.

Website/invoice sources are optional. The onboarding agent does not gain a new
crawler or OCR service; inaccessible inputs are requested as readable facts/file
content and invoice layout work is handed to Template Designer.

Validation: `npm test` in `document_inteligence`, root
`node --test server/orchestrator.test.mjs`, and root `npm run build`.
