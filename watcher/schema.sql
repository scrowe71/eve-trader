-- eve-trader cloud history (Cloudflare D1)
-- Apply with:  npx wrangler d1 execute eve-trader --remote --file=schema.sql

-- Every wallet market transaction ever seen (character and corp division wallets).
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,          -- "char:<id>" or "corp:<corpId>:<division>"
  date           TEXT NOT NULL,          -- ISO 8601 from ESI
  type_id        INTEGER NOT NULL,
  quantity       INTEGER NOT NULL,
  unit_price     REAL NOT NULL,
  is_buy         INTEGER NOT NULL,
  location_id    INTEGER NOT NULL,
  client_id      INTEGER,
  journal_ref_id INTEGER
);
CREATE INDEX IF NOT EXISTS tx_source_date ON transactions (source, date);

-- Wallet journal entries (fees, taxes, contract rewards…).
CREATE TABLE IF NOT EXISTS journal (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL,
  date            TEXT NOT NULL,
  ref_type        TEXT NOT NULL,
  amount          REAL,
  balance         REAL,
  context_id      INTEGER,
  context_id_type TEXT,
  first_party_id  INTEGER,
  second_party_id INTEGER,
  description     TEXT
);
CREATE INDEX IF NOT EXISTS j_source_date ON journal (source, date);

-- Courier contracts (your hauls) with what they actually cost.
CREATE TABLE IF NOT EXISTS hauls (
  contract_id       INTEGER PRIMARY KEY,
  owner             INTEGER NOT NULL,    -- character id of the watcher that saw it
  issuer_id         INTEGER,
  status            TEXT,
  start_location_id INTEGER,
  end_location_id   INTEGER,
  volume            REAL,
  collateral        REAL,
  reward            REAL,
  title             TEXT,
  date_issued       TEXT,
  date_accepted     TEXT,
  date_completed    TEXT,
  updated           TEXT
);
CREATE INDEX IF NOT EXISTS hauls_owner ON hauls (owner, date_issued);

-- Site settings + the doctrine tracker, shared between your devices.
CREATE TABLE IF NOT EXISTS settings (
  char    INTEGER PRIMARY KEY,
  data    TEXT NOT NULL,
  updated TEXT NOT NULL
);
