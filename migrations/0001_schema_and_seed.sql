-- HVP RCM Fee Schedule Schema (v2: adds contract_type to fix UNIQUE collision bug)
CREATE TABLE IF NOT EXISTS payers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  plan_type TEXT NOT NULL DEFAULT 'PPO'
);

CREATE TABLE IF NOT EXISTS fee_schedules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  payer_id       INTEGER NOT NULL REFERENCES payers(id) ON DELETE CASCADE,
  cpt_code       TEXT NOT NULL,
  modifier       TEXT,
  contract_type  TEXT NOT NULL DEFAULT 'PPO',
  effective_date TEXT NOT NULL,
  expiry_date    TEXT,
  rate_cents     INTEGER NOT NULL,
  rate_type      TEXT NOT NULL DEFAULT 'FLAT',
  description    TEXT,
  UNIQUE (payer_id, cpt_code, modifier, contract_type, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_fee_cpt       ON fee_schedules(cpt_code);
CREATE INDEX IF NOT EXISTS idx_fee_payer_cpt ON fee_schedules(payer_id, cpt_code);

INSERT OR IGNORE INTO payers (id, name, plan_type) VALUES
  (1, 'Medicare',  'Medicare'),
  (2, 'Aetna PPO', 'PPO'),
  (3, 'BCBS HMO',  'HMO');
