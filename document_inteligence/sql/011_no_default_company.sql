-- No company is the default. A company exists only when someone creates it.
ALTER TABLE di.tenant DROP COLUMN IF EXISTS is_default;

-- A new company's profile takes the name it was created with.
CREATE OR REPLACE FUNCTION di.new_company_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO di.company_profile (tenant_id, name) VALUES (NEW.id, NEW.name);
  RETURN NEW;
END $$;
