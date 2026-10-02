CREATE TABLE di.media_kit_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  category text NOT NULL CHECK (category IN ('logo','event_photo','news','certification','qualification','award')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  alt_text text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT 'en',
  asset_date date,
  issuer text,
  source_url text,
  credential text,
  file_id text NOT NULL,
  file_name text NOT NULL,
  file_bytes bigint NOT NULL CHECK (file_bytes > 0),
  file_mime text NOT NULL,
  file_url text NOT NULL,
  file_link text NOT NULL,
  visibility text NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft','published','archived')),
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text DEFAULT di.current_actor(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz,
  deleted_by text
);

CREATE INDEX di_media_kit_asset_category_idx
  ON di.media_kit_asset (tenant_id, category, sort_order, asset_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX di_media_kit_asset_visibility_idx
  ON di.media_kit_asset (tenant_id, visibility, sort_order)
  WHERE deleted_at IS NULL;
CREATE INDEX di_media_kit_asset_file_idx
  ON di.media_kit_asset (tenant_id, file_id)
  WHERE deleted_at IS NULL;

CREATE TABLE di.media_kit_share (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'Media Kit share',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text DEFAULT di.current_actor(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz,
  deleted_by text
);

CREATE INDEX di_media_kit_share_tenant_idx
  ON di.media_kit_share (tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE di.media_kit_asset ENABLE ROW LEVEL SECURITY;
CREATE POLICY di_tenant_isolation ON di.media_kit_asset
  USING (tenant_id=di.current_tenant()) WITH CHECK (tenant_id=di.current_tenant());
CREATE TRIGGER di_touch BEFORE UPDATE ON di.media_kit_asset FOR EACH ROW EXECUTE FUNCTION di.touch();
CREATE TRIGGER di_audit AFTER INSERT OR UPDATE ON di.media_kit_asset FOR EACH ROW EXECUTE FUNCTION di.audit();
CREATE TRIGGER di_no_delete BEFORE DELETE ON di.media_kit_asset FOR EACH ROW EXECUTE FUNCTION di.forbid_delete();
CREATE TRIGGER di_no_truncate BEFORE TRUNCATE ON di.media_kit_asset FOR EACH STATEMENT EXECUTE FUNCTION di.forbid_delete();

ALTER TABLE di.media_kit_share ENABLE ROW LEVEL SECURITY;
CREATE POLICY di_tenant_isolation ON di.media_kit_share
  USING (tenant_id=di.current_tenant()) WITH CHECK (tenant_id=di.current_tenant());
CREATE TRIGGER di_touch BEFORE UPDATE ON di.media_kit_share FOR EACH ROW EXECUTE FUNCTION di.touch();
CREATE TRIGGER di_audit AFTER INSERT OR UPDATE ON di.media_kit_share FOR EACH ROW EXECUTE FUNCTION di.audit();
CREATE TRIGGER di_no_delete BEFORE DELETE ON di.media_kit_share FOR EACH ROW EXECUTE FUNCTION di.forbid_delete();
CREATE TRIGGER di_no_truncate BEFORE TRUNCATE ON di.media_kit_share FOR EACH STATEMENT EXECUTE FUNCTION di.forbid_delete();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='di_app') THEN
    GRANT SELECT,INSERT,UPDATE ON di.media_kit_asset TO di_app;
    GRANT SELECT,INSERT,UPDATE ON di.media_kit_share TO di_app;
  END IF;
END $$;

-- Share tokens are opaque capabilities. Resolve one token to its tenant without
-- exposing the share table or requiring a tenant setting before the lookup.
CREATE OR REPLACE FUNCTION di.media_kit_tenant_for_share(p_token_hash text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = di, pg_temp
AS $$
  SELECT tenant_id
  FROM di.media_kit_share
  WHERE token_hash = p_token_hash
    AND deleted_at IS NULL
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION di.media_kit_tenant_for_share(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='di_app') THEN
    GRANT EXECUTE ON FUNCTION di.media_kit_tenant_for_share(text) TO di_app;
  END IF;
END $$;
