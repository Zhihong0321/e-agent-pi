-- A company has a short sign-in code. A login is company code + username + password, so two
-- companies can both have an "admin" without clashing (users are unique per company, not globally).
ALTER TABLE di.tenant ADD COLUMN IF NOT EXISTS code text;

-- Lowercase letters, digits and hyphens made from a name, with -2, -3 ... when the code is taken.
CREATE OR REPLACE FUNCTION di.next_company_code(src text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE base text; candidate text; i int := 1;
BEGIN
  base := trim(both '-' from lower(regexp_replace(coalesce(src, ''), '[^a-zA-Z0-9]+', '-', 'g')));
  base := trim(both '-' from left(base, 40));
  IF base = '' THEN base := 'company'; END IF;
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM di.tenant WHERE code = candidate) LOOP
    i := i + 1;
    candidate := base || '-' || i;
  END LOOP;
  RETURN candidate;
END $$;

-- A company created without a code (every older insert) gets one from its name; a given code is lowercased.
CREATE OR REPLACE FUNCTION di.tenant_code_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS NULL OR btrim(NEW.code) = '' THEN NEW.code := di.next_company_code(NEW.name);
  ELSE NEW.code := lower(btrim(NEW.code));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS di_tenant_code ON di.tenant;
CREATE TRIGGER di_tenant_code BEFORE INSERT ON di.tenant
  FOR EACH ROW EXECUTE FUNCTION di.tenant_code_default();

-- Companies that already exist take their code from their name, oldest first.
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT id, name FROM di.tenant WHERE code IS NULL ORDER BY created_at, id LOOP
    UPDATE di.tenant SET code = di.next_company_code(t.name) WHERE id = t.id;
  END LOOP;
END $$;

ALTER TABLE di.tenant ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_code_key ON di.tenant (code);
ALTER TABLE di.tenant ADD CONSTRAINT tenant_code_format CHECK (code ~ '^[a-z0-9][a-z0-9-]{0,39}$');
