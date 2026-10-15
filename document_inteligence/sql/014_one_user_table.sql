-- One user table. A person is one row in public.users (server/user-schema.mjs); Document
-- Intelligence keeps no people of its own. This moves the retired di.company_member rows into
-- users, points expense claims at users, drops the old table, and lets agents read users
-- (without password hashes) for their own company only.

DO $$
BEGIN
  IF to_regclass('di.company_member') IS NOT NULL THEN
    -- Match each record to its user: a link only counts inside the same company; otherwise the
    -- same email in the same company is the same person. (Plain UPDATEs, so the audit trigger
    -- records the matching.)
    UPDATE di.company_member m SET user_id = NULL
     WHERE m.user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.users u WHERE u.id = m.user_id AND u.company_tenant_id = m.tenant_id::text);
    UPDATE di.company_member m SET user_id = u.id
      FROM public.users u
     WHERE m.user_id IS NULL AND m.deleted_at IS NULL AND m.email IS NOT NULL
       AND u.company_tenant_id = m.tenant_id::text AND lower(u.email) = lower(m.email);

    -- A matched record fills the user's empty fields.
    UPDATE public.users u SET
      email = coalesce(nullif(u.email, ''), lower(m.email)),
      phone = coalesce(nullif(u.phone, ''), m.phone),
      position = coalesce(nullif(u.position, ''), m.position),
      department = coalesce(nullif(u.department, ''), m.department),
      location = coalesce(nullif(u.location, ''), m.location),
      notes = coalesce(nullif(u.notes, ''), m.notes),
      updated_at = now()
    FROM di.company_member m
    WHERE m.user_id = u.id AND m.deleted_at IS NULL;

    -- Everyone else becomes a user who cannot sign in (no username, no password). The member id
    -- becomes the user id, so claims filed against the member keep pointing at the same person.
    PERFORM public.ensure_user_categories(t) FROM (SELECT DISTINCT tenant_id::text AS t FROM di.company_member
      WHERE user_id IS NULL AND deleted_at IS NULL) AS companies;
    INSERT INTO public.users (id, company_tenant_id, category_id, display_name, active,
        email, phone, position, department, location, notes, created_at, updated_at)
    SELECT m.id::text, m.tenant_id::text, c.id, m.name, true,
           lower(m.email), m.phone, m.position, m.department, m.location, m.notes, m.created_at, m.updated_at
      FROM di.company_member m
      JOIN public.user_category c ON c.company_tenant_id = m.tenant_id::text AND c.is_default
     WHERE m.user_id IS NULL AND m.deleted_at IS NULL
    ON CONFLICT (id) DO NOTHING;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'di' AND table_name = 'expense_claim' AND column_name = 'claimant_member_id') THEN
      UPDATE di.expense_claim c SET claimant_user_id = coalesce(m.user_id, m.id::text)
        FROM di.company_member m
       WHERE c.claimant_user_id IS NULL AND c.claimant_member_id = m.id;
      ALTER TABLE di.expense_claim DROP COLUMN claimant_member_id;
    END IF;

    DROP TABLE di.company_member;
  END IF;
END $$;

-- Agents read users of their own company; they never see password hashes and never write users
-- (writes go through the host's user service with a Superadmin actor).
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_category ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'di_app') THEN
    REVOKE ALL ON public.users, public.user_category FROM di_app;
    GRANT SELECT (id, company_tenant_id, category_id, display_name, username, active,
                  email, phone, position, department, location, notes, created_at, updated_at)
      ON public.users TO di_app;
    GRANT SELECT ON public.user_category TO di_app;
    DROP POLICY IF EXISTS di_company_users ON public.users;
    CREATE POLICY di_company_users ON public.users FOR SELECT TO di_app
      USING (company_tenant_id = di.current_tenant()::text);
    DROP POLICY IF EXISTS di_company_categories ON public.user_category;
    CREATE POLICY di_company_categories ON public.user_category FOR SELECT TO di_app
      USING (company_tenant_id = di.current_tenant()::text);
  END IF;
END $$;
