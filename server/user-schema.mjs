// The one user schema. A user is one row in `users`; there is no second people table.
// Every user belongs to one company and one category. The category is what the user may do:
// its `access` is the level code enforces (superadmin, department_head, user) and `limits`
// holds the owner's business limits (e.g. {"max_discount_pct": 8}). Department is where the
// user works, so a department head's scope is their own department.
//
// Sign-in is username + password inside the company. A user without both cannot sign in
// (a person on record, e.g. for expense claims); `active=false` disables a user.
//
// The host runs this at boot (users.mjs ensureUsers) and Document Intelligence runs it before
// its own migrations, so PGlite tests and production build users from this one definition.

export const ACCESS_LEVELS = ['superadmin', 'department_head', 'user'];

/** Categories every new company starts with; the Superadmin can rename, add and change them. */
export const DEFAULT_CATEGORIES = [
  { name: 'Superadmin', access: 'superadmin', is_default: false },
  { name: 'Department head', access: 'department_head', is_default: false },
  { name: 'Staff', access: 'user', is_default: true },
];

const defaults = DEFAULT_CATEGORIES
  .map((c) => `('${c.name}','${c.access}',${c.is_default})`).join(',');

export const USER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_category (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('superadmin','department_head','user')),
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE UNIQUE INDEX IF NOT EXISTS user_category_name_key ON user_category (company_tenant_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS user_category_default_key ON user_category (company_tenant_id) WHERE is_default;

-- Seeds a company's starting categories once; a company that already has categories keeps its own.
CREATE OR REPLACE FUNCTION ensure_user_categories(company TEXT) RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO user_category (company_tenant_id, name, access, is_default)
  SELECT company, v.name, v.access, v.is_default FROM (VALUES ${defaults}) AS v(name, access, is_default)
   WHERE NOT EXISTS (SELECT 1 FROM user_category c WHERE c.company_tenant_id = company);
$fn$;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  company_tenant_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES user_category(id),
  display_name TEXT NOT NULL,
  username TEXT,
  password_hash TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  email TEXT, phone TEXT, position TEXT, department TEXT, location TEXT, notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- Upgrade from the role/tier shape: each role becomes the matching starting category.
DO $up$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'role') THEN
    -- Pre-company accounts cannot sign in (sign-in names a company); detach their chats and drop them.
    IF to_regclass('sessions') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'sessions' AND column_name = 'user_id') THEN
      UPDATE sessions SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE coalesce(company_tenant_id, '') = '');
    END IF;
    IF to_regclass('user_agents') IS NOT NULL THEN
      DELETE FROM user_agents WHERE user_id IN (SELECT id FROM users WHERE coalesce(company_tenant_id, '') = '');
    END IF;
    IF to_regclass('user_sessions') IS NOT NULL THEN
      DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE coalesce(company_tenant_id, '') = '');
    END IF;
    DELETE FROM users WHERE coalesce(company_tenant_id, '') = '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS category_id TEXT REFERENCES user_category(id);
    PERFORM ensure_user_categories(company_tenant_id) FROM (SELECT DISTINCT company_tenant_id FROM users) AS companies;
    UPDATE users u SET category_id = c.id FROM user_category c
     WHERE u.category_id IS NULL AND c.company_tenant_id = u.company_tenant_id
       AND c.access = CASE u.role WHEN 'admin' THEN 'superadmin' ELSE u.role END;
    ALTER TABLE users DROP COLUMN role;
    ALTER TABLE users DROP COLUMN IF EXISTS tier;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
    DROP INDEX IF EXISTS users_company_username_key;
    ALTER TABLE users ALTER COLUMN company_tenant_id SET NOT NULL;
    ALTER TABLE users ALTER COLUMN category_id SET NOT NULL;
    ALTER TABLE users ALTER COLUMN username DROP NOT NULL;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
  END IF;
END $up$;

-- A username is unique inside its company: sign-in is company code + username.
CREATE UNIQUE INDEX IF NOT EXISTS users_company_username_idx ON users (company_tenant_id, username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_company_idx ON users (company_tenant_id);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_category_idx ON users (category_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);
`;

/** Creates or upgrades the user schema. `db` is a pg Pool/Client or a DI adapter with exec(). */
export async function ensureUserSchema(db) {
  if (typeof db.exec === 'function') await db.exec(USER_SCHEMA_SQL);
  else await db.query(USER_SCHEMA_SQL);
}
