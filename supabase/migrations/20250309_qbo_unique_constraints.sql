-- Ensure QBO entity/account uniqueness to avoid duplicate imports on reconnect

CREATE UNIQUE INDEX IF NOT EXISTS qbo_coa_creations_business_account_uq
  ON qbo_coa_creations (business_id, qbo_account_id);

CREATE UNIQUE INDEX IF NOT EXISTS qbo_vendor_creations_business_entity_uq
  ON qbo_vendor_creations (business_id, qbo_entity_type, qbo_entity_id);
