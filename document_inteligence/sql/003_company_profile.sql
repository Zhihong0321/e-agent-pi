-- Company data has one canonical home. Tenant remains the ownership boundary.
CREATE TABLE di.company_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES di.tenant(id) DEFAULT di.current_tenant(),
  name text NOT NULL DEFAULT '', legal_name text, reg_no text, tin text, sst_no text,
  msic_code text, business_activity text, business_type text, customer_type text,
  country text, timezone text, language text NOT NULL DEFAULT 'en',
  address jsonb NOT NULL DEFAULT '{}', phone text, email text, website text,
  currency text NOT NULL DEFAULT 'MYR', logo_url text, bank_details text,
  payment_terms_days integer CHECK (payment_terms_days BETWEEN 0 AND 3650),
  payment_instructions text, tax_status text, invoice_reference text,
  settings jsonb NOT NULL DEFAULT '{}', evidence jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text DEFAULT di.current_actor(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by text,
  deleted_at timestamptz, deleted_by text
);
INSERT INTO di.company_profile (tenant_id, name, legal_name, reg_no, tin, sst_no, msic_code,
  business_activity, address, phone, email, website, currency, logo_url, bank_details, settings)
SELECT id, CASE WHEN name = 'My Company' THEN '' ELSE name END, legal_name, reg_no, tin,
  sst_no, msic_code, business_activity, address, phone, email, website, currency, logo_url,
  bank_details, settings FROM di.tenant;

-- Keep tenant.name only as the workspace label, not as a document header.
ALTER TABLE di.tenant DROP COLUMN legal_name, DROP COLUMN reg_no, DROP COLUMN tin,
  DROP COLUMN sst_no, DROP COLUMN msic_code, DROP COLUMN business_activity,
  DROP COLUMN address, DROP COLUMN phone, DROP COLUMN email, DROP COLUMN website,
  DROP COLUMN currency, DROP COLUMN logo_url, DROP COLUMN bank_details, DROP COLUMN settings;

CREATE FUNCTION di.new_company_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO di.company_profile (tenant_id, name)
  VALUES (NEW.id, CASE WHEN NEW.name = 'My Company' THEN '' ELSE NEW.name END);
  RETURN NEW;
END $$;
CREATE TRIGGER di_company_profile AFTER INSERT ON di.tenant
  FOR EACH ROW EXECUTE FUNCTION di.new_company_profile();

CREATE FUNCTION di.bump_company_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER di_revision BEFORE UPDATE ON di.company_profile
  FOR EACH ROW EXECUTE FUNCTION di.bump_company_revision();

CREATE TABLE di.company_profile_field_def (
  key text PRIMARY KEY, label text NOT NULL, type text NOT NULL,
  section text NOT NULL, required_for text, options jsonb NOT NULL DEFAULT '[]',
  help text NOT NULL DEFAULT '', sort integer NOT NULL DEFAULT 0
);
INSERT INTO di.company_profile_field_def (key,label,type,section,required_for,help,sort) VALUES
 ('name','Company / trading name','text','Identity','minimum','The name customers know you by.',10),
 ('legal_name','Legal name','text','Identity',NULL,'Registered name, if different.',11),
 ('reg_no','Registration number','text','Identity',NULL,'Business registration number, where applicable.',12),
 ('country','Country code','country','Identity','minimum','Two-letter country code, for example MY.',13),
 ('business_type','Business type','select','Business','minimum','Do you sell products, services, or both?',20),
 ('business_activity','Business activity','textarea','Business','minimum','Briefly describe what the company does.',21),
 ('customer_type','Customer type','select','Business',NULL,'Who do you sell to?',22),
 ('website','Website','url','Contact',NULL,'Optional. Use it as evidence; confirm extracted information.',30),
 ('email','Business email','email','Contact',NULL,'Provide an email or phone for minimum setup.',31),
 ('phone','Business phone','text','Contact',NULL,'Provide a phone or email for minimum setup.',32),
 ('address','Billing address','address','Contact','invoice','Address printed on documents.',33),
 ('currency','Currency','currency','Billing','minimum','Three-letter currency code, for example MYR.',40),
 ('timezone','Timezone','timezone','Billing',NULL,'For example Asia/Kuala_Lumpur.',41),
 ('payment_terms_days','Payment terms (days)','number','Billing',NULL,'0 means payment is due immediately.',42),
 ('bank_details','Bank details','textarea','Billing',NULL,'Bank name, account name and account number. Never passwords or PINs.',43),
 ('payment_instructions','Payment instructions','textarea','Billing',NULL,'Instructions shown to customers.',44),
 ('tax_status','Tax status','select','Billing','invoice','Confirm with the business; do not infer from an old invoice.',45),
 ('tin','Tax identification number','text','Billing',NULL,'Where applicable.',46),
 ('sst_no','SST registration number','text','Billing',NULL,'Where applicable.',47),
 ('msic_code','Industry classification code','text','Billing',NULL,'Where applicable.',48),
 ('logo_url','Logo URL','url','Branding',NULL,'Public HTTPS image URL.',50),
 ('language','Document language','text','Branding',NULL,'Preferred language code.',51),
 ('invoice_reference','Existing invoice reference','text','Branding',NULL,'Optional uploaded file reference for the Template Designer.',52);
UPDATE di.company_profile_field_def SET options = '["products","services","both"]' WHERE key='business_type';
UPDATE di.company_profile_field_def SET options = '["b2b","b2c","both"]' WHERE key='customer_type';
UPDATE di.company_profile_field_def SET options = '["not_registered","registered","exempt","needs_review"]' WHERE key='tax_status';

CREATE TABLE di.onboarding_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  checks jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), created_by text DEFAULT di.current_actor(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by text,
  deleted_at timestamptz, deleted_by text
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['company_profile','onboarding_progress'] LOOP
    EXECUTE format('ALTER TABLE di.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY di_tenant_isolation ON di.%I USING (tenant_id=di.current_tenant()) WITH CHECK (tenant_id=di.current_tenant())',t);
    EXECUTE format('CREATE TRIGGER di_touch BEFORE UPDATE ON di.%I FOR EACH ROW EXECUTE FUNCTION di.touch()',t);
    EXECUTE format('CREATE TRIGGER di_audit AFTER INSERT OR UPDATE ON di.%I FOR EACH ROW EXECUTE FUNCTION di.audit()',t);
    EXECUTE format('CREATE TRIGGER di_no_delete BEFORE DELETE ON di.%I FOR EACH ROW EXECUTE FUNCTION di.forbid_delete()',t);
    EXECUTE format('CREATE TRIGGER di_no_truncate BEFORE TRUNCATE ON di.%I FOR EACH STATEMENT EXECUTE FUNCTION di.forbid_delete()',t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='di_app') THEN
    GRANT SELECT,INSERT,UPDATE ON di.company_profile,di.onboarding_progress TO di_app;
    GRANT SELECT ON di.company_profile_field_def TO di_app;
  END IF;
END $$;

-- Recovery snapshots are owner-only, never available to ordinary agent tools.
CREATE TABLE di.reset_backup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES di.tenant(id),
  created_at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL,
  snapshot jsonb NOT NULL
);
REVOKE ALL ON di.reset_backup FROM PUBLIC;
