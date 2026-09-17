-- ============================================================================
-- BI Warehouse Schema (PostgreSQL)
--
-- This is the target warehouse for the ISP BI system. It is fed by the ETL
-- sync job (src/etl/sync.js), which pulls from the real production SQL
-- Server databases (billGENIXDB + TicketingDB) and lands data here.
--
-- IMPORTANT — how fact_billing / fact_collection / fact_refund /
-- fact_adjustment map to the source: all four come from the SAME source
-- table, billGENIXDB.dbo.BillingMaster, split by the RefTypeID column.
-- This was confirmed with real data, not assumed:
--   RefTypeID 1,2,3,7,8,10 (INV_OTC, INV_MRC, INV_SHIFT, INV_OTHERS,
--                            DIRECT_SELL, DownChg)  -> billing charges (Debit)
--   RefTypeID 4  (MR = Money Receipt)               -> collection (Credit)
--   RefTypeID 5  (REFUND)                            -> refund (Debit)
--   RefTypeID 6  (ADJUSTMENT)                        -> adjustment (Credit)
-- See claude/full-project-context.md section 3.7 for the full confirmed
-- mapping and real row counts/totals used to verify this.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- DIMENSION TABLES
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dim_customer (
    customer_id         VARCHAR(64) PRIMARY KEY,   -- source: CustomerMaster.CustomerID
    customer_name        TEXT,
    pop_id               VARCHAR(64),
    package_id            VARCHAR(64),
    status_id             VARCHAR(64),
    connection_type       TEXT,
    resident_type         TEXT,
    entry_date            TIMESTAMP,
    activated_date         TIMESTAMP,
    source_synced_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dim_pop (
    pop_id                VARCHAR(64) PRIMARY KEY,  -- source: POPMaster.POPID
    pop_name               TEXT,
    source_synced_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dim_package (
    package_id             VARCHAR(64) PRIMARY KEY,  -- source: PackageMaster.BID
    package_name             TEXT,
    bandwidth                 TEXT,
    price                       NUMERIC(14,2),
    source_synced_at          TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dim_region (
    region_id              VARCHAR(64) PRIMARY KEY,
    division_name            TEXT,
    district_name             TEXT,
    city_corporation           TEXT,
    source_synced_at           TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dim_status (
    status_id               VARCHAR(64) PRIMARY KEY,  -- source: StatusMaster.StatusID
    status_name                TEXT,
    source_synced_at            TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dim_department (
    department_id             VARCHAR(64) PRIMARY KEY,  -- source: Tk_Department.DeptID
    department_name              TEXT,
    source_synced_at              TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dim_ticket_type (
    ticket_type_id             VARCHAR(64) PRIMARY KEY,  -- source: Tk_TicketType.TicketTypeID
    ticket_type_name              TEXT,
    source_synced_at               TIMESTAMP NOT NULL DEFAULT now()
);

-- Standard generated calendar dimension. Populate once with a script/loop
-- (see scripts/generate-dim-date.sql if you add one) — not fed by ETL.
CREATE TABLE IF NOT EXISTS dim_date (
    date_key                DATE PRIMARY KEY,
    year                      INT NOT NULL,
    quarter                   INT NOT NULL,
    month                      INT NOT NULL,
    month_name                  TEXT NOT NULL,
    day                          INT NOT NULL,
    day_of_week                   INT NOT NULL,
    week_of_year                    INT NOT NULL
);

-- ---------------------------------------------------------------------------
-- FACT TABLES
-- ---------------------------------------------------------------------------

-- fact_billing: real charges (accrual). Source: BillingMaster WHERE RefTypeID
-- IN (1,2,3,7,8,10). Amount = Debit.
CREATE TABLE IF NOT EXISTS fact_billing (
    billing_sk              BIGSERIAL PRIMARY KEY,
    source_snid              BIGINT NOT NULL,        -- BillingMaster.SNID (natural key from source)
    customer_id                VARCHAR(64) NOT NULL REFERENCES dim_customer(customer_id),
    ref_type_id                  SMALLINT NOT NULL,     -- 1,2,3,7,8,10 (see mapping above)
    ref_type_name                  TEXT NOT NULL,          -- denormalized for easy reading (INV_MRC, etc.)
    ref_date                        DATE NOT NULL,
    tran_id                           VARCHAR(64),
    amount                              NUMERIC(18,4) NOT NULL,   -- BillingMaster.Debit
    pop_id                                VARCHAR(64) REFERENCES dim_pop(pop_id),
    package_id                             VARCHAR(64) REFERENCES dim_package(package_id),
    source_synced_at                         TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (source_snid)
);
CREATE INDEX IF NOT EXISTS idx_fact_billing_customer_date ON fact_billing(customer_id, ref_date);
CREATE INDEX IF NOT EXISTS idx_fact_billing_date ON fact_billing(ref_date);

-- fact_collection: real cash received. Source: BillingMaster WHERE
-- RefTypeID = 4 (MR / Money Receipt). Amount = Credit.
CREATE TABLE IF NOT EXISTS fact_collection (
    collection_sk            BIGSERIAL PRIMARY KEY,
    source_snid                BIGINT NOT NULL,
    customer_id                  VARCHAR(64) NOT NULL REFERENCES dim_customer(customer_id),
    ref_date                       DATE NOT NULL,
    tran_id                          VARCHAR(64),
    tran_mode_id                       VARCHAR(64),          -- payment channel (cash/bKash/Nagad/etc.)
    tran_mode_name                       TEXT,
    amount                                  NUMERIC(18,4) NOT NULL,   -- BillingMaster.Credit
    pop_id                                    VARCHAR(64) REFERENCES dim_pop(pop_id),
    package_id                                  VARCHAR(64) REFERENCES dim_package(package_id),
    source_synced_at                            TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (source_snid)
);
-- FIX 2026-09-17: package_id was missing from fact_collection even though
-- BillingMaster.BID is pulled for EVERY row (billing AND collection) in the
-- same SELECT -- see etl/tables/billingMaster.mjs. It was real, available
-- data that the original ETL mapping just never carried into this table.
-- ALTER (not just adding it to CREATE TABLE) because this table can already
-- exist in a real deployed warehouse without this column -- CREATE TABLE IF
-- NOT EXISTS alone would silently do nothing on a database that already has
-- fact_collection, so an explicit ALTER is required to actually add it.
ALTER TABLE fact_collection ADD COLUMN IF NOT EXISTS package_id VARCHAR(64) REFERENCES dim_package(package_id);
CREATE INDEX IF NOT EXISTS idx_fact_collection_customer_date ON fact_collection(customer_id, ref_date);
CREATE INDEX IF NOT EXISTS idx_fact_collection_date ON fact_collection(ref_date);
CREATE INDEX IF NOT EXISTS idx_fact_collection_package ON fact_collection(package_id);

-- fact_refund: RefTypeID = 5 (REFUND). NOTE: recorded as Debit in source,
-- not a negative Credit — do NOT fold this into fact_collection as -amount.
CREATE TABLE IF NOT EXISTS fact_refund (
    refund_sk                 BIGSERIAL PRIMARY KEY,
    source_snid                 BIGINT NOT NULL,
    customer_id                   VARCHAR(64) NOT NULL REFERENCES dim_customer(customer_id),
    ref_date                        DATE NOT NULL,
    amount                             NUMERIC(18,4) NOT NULL,  -- BillingMaster.Debit
    source_synced_at                     TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (source_snid)
);

-- fact_adjustment: RefTypeID = 6 (ADJUSTMENT). Amount = Credit.
CREATE TABLE IF NOT EXISTS fact_adjustment (
    adjustment_sk               BIGSERIAL PRIMARY KEY,
    source_snid                   BIGINT NOT NULL,
    customer_id                     VARCHAR(64) NOT NULL REFERENCES dim_customer(customer_id),
    ref_date                          DATE NOT NULL,
    amount                               NUMERIC(18,4) NOT NULL,  -- BillingMaster.Credit
    source_synced_at                       TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (source_snid)
);

-- fact_ticket: source TicketingDB core ticket table + TicketHistory.
-- Exact source table/columns TBD — confirm against real TicketingDB ticket
-- table before wiring src/etl/tables/tickets.js for real (see that file's
-- top comment for the placeholder that needs finalizing).
CREATE TABLE IF NOT EXISTS fact_ticket (
    ticket_sk                  BIGSERIAL PRIMARY KEY,
    source_ticket_id              BIGINT NOT NULL,
    customer_id                      VARCHAR(64) REFERENCES dim_customer(customer_id),
    department_id                       VARCHAR(64) REFERENCES dim_department(department_id),
    ticket_type_id                        VARCHAR(64) REFERENCES dim_ticket_type(ticket_type_id),
    opened_date                             TIMESTAMP,
    resolved_date                              TIMESTAMP,
    status                                       TEXT,
    source_synced_at                               TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (source_ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_ticket_opened ON fact_ticket(opened_date);

-- fact_customer_lifecycle_event: package changes / status changes over
-- time. Source: CustomerSubscriptionHistory. Effective-dated so any fact
-- can join to "which package was this customer on at date X".
CREATE TABLE IF NOT EXISTS fact_customer_lifecycle_event (
    event_sk                   BIGSERIAL PRIMARY KEY,
    source_event_id               BIGINT NOT NULL,
    customer_id                      VARCHAR(64) NOT NULL REFERENCES dim_customer(customer_id),
    package_id                          VARCHAR(64) REFERENCES dim_package(package_id),
    event_type                             TEXT,          -- e.g. 'upgrade', 'downgrade', 'activation', 'suspension'
    effective_from                            DATE NOT NULL,
    effective_to                                 DATE,        -- NULL = still current
    source_synced_at                               TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_customer_range ON fact_customer_lifecycle_event(customer_id, effective_from, effective_to);

-- ---------------------------------------------------------------------------
-- ETL BOOKKEEPING
-- ---------------------------------------------------------------------------

-- Tracks last successful sync per source table so the daily job knows
-- where to resume (incremental tables) and so a failed table never
-- silently advances — see src/etl/lib/syncLog.js.
CREATE TABLE IF NOT EXISTS etl_sync_log (
    source_table            TEXT PRIMARY KEY,
    last_synced_at             TIMESTAMP,          -- watermark used for incremental pulls
    last_run_started_at          TIMESTAMP,
    last_run_finished_at           TIMESTAMP,
    last_run_status                   TEXT,            -- 'success' | 'failed'
    last_run_row_count                   INT,
    last_error                             TEXT
);

-- ============================================================================
-- PATCH (added after first real sync run): fact->dimension foreign keys
-- removed.
--
-- Real data confirmed two things the design didn't anticipate:
--  1. BillingMaster has CustomerIDs (real production rows, RefTypeID=4
--     collection entries observed first) that do NOT exist in the current
--     CustomerMaster table — legacy/archived customers whose billing
--     history outlived their master record. This is normal for a
--     15+ year-old billing system, not a data error to "fix".
--  2. dim_department and dim_ticket_type are not populated by any ETL step
--     — no TicketingDB source table for either was ever confirmed (see
--     src/etl/tables/tickets.mjs header comment) — so ANY non-null
--     department_id/ticket_type_id on a ticket violated the FK.
--
-- Rather than block real fact data on incomplete/orphaned dimension data,
-- these FKs are dropped. Fact tables keep the raw source IDs; resolving
-- them to names happens via LEFT JOIN in the semantic layer (src/semantic),
-- which naturally shows "Unknown"/null for a dimension row that doesn't
-- exist yet, instead of the whole sync aborting.
-- ============================================================================

ALTER TABLE fact_billing DROP CONSTRAINT IF EXISTS fact_billing_customer_id_fkey;
ALTER TABLE fact_billing DROP CONSTRAINT IF EXISTS fact_billing_pop_id_fkey;
ALTER TABLE fact_billing DROP CONSTRAINT IF EXISTS fact_billing_package_id_fkey;

ALTER TABLE fact_collection DROP CONSTRAINT IF EXISTS fact_collection_customer_id_fkey;
ALTER TABLE fact_collection DROP CONSTRAINT IF EXISTS fact_collection_pop_id_fkey;
-- FIX 2026-09-17: package_id was added to fact_collection with a live FK
-- to dim_package (unlike customer_id/pop_id above, this one was never
-- dropped when the column was introduced). Collection rows (RefTypeID=4)
-- legitimately reference legacy package IDs not present in the current
-- dim_package (same orphan-legacy-row pattern as customer_id elsewhere,
-- dim_package only has 73 rows) -- the FK violation on the very first
-- such row aborted the whole BillingMaster sync before any collection
-- rows committed, which is why fact_collection was stuck at 0 rows while
-- fact_billing/fact_refund/fact_adjustment synced fine (confirmed via
-- real row counts: fact_billing 6337845, fact_collection 0).
ALTER TABLE fact_collection DROP CONSTRAINT IF EXISTS fact_collection_package_id_fkey;

ALTER TABLE fact_refund DROP CONSTRAINT IF EXISTS fact_refund_customer_id_fkey;

ALTER TABLE fact_adjustment DROP CONSTRAINT IF EXISTS fact_adjustment_customer_id_fkey;

ALTER TABLE fact_ticket DROP CONSTRAINT IF EXISTS fact_ticket_customer_id_fkey;
ALTER TABLE fact_ticket DROP CONSTRAINT IF EXISTS fact_ticket_department_id_fkey;
ALTER TABLE fact_ticket DROP CONSTRAINT IF EXISTS fact_ticket_ticket_type_id_fkey;

ALTER TABLE fact_customer_lifecycle_event DROP CONSTRAINT IF EXISTS fact_customer_lifecycle_event_customer_id_fkey;
ALTER TABLE fact_customer_lifecycle_event DROP CONSTRAINT IF EXISTS fact_customer_lifecycle_event_package_id_fkey;

-- ============================================================================
-- PATCH 2 (added after the first FK-fixed run hit batch 18 of ~250):
-- widen fact-table string ID columns from VARCHAR(64) to TEXT.
--
-- Real error hit during the real run: "value too long for type character
-- varying(64)" on one of fact_billing/fact_collection's string columns
-- (customer_id, tran_id, tran_mode_id, pop_id, or package_id — the error
-- doesn't say which). Rather than guess which column and pick another
-- arbitrary cap that could just as easily be blown by a later batch of this
-- ~12.4M-row table, these columns are widened to unbounded TEXT. This is a
-- legacy system with 15+ years of data — there is no reliable max length to
-- assume for a natural-key/reference string pulled from it.
-- ============================================================================

ALTER TABLE fact_billing ALTER COLUMN customer_id TYPE TEXT;
ALTER TABLE fact_billing ALTER COLUMN tran_id TYPE TEXT;
ALTER TABLE fact_billing ALTER COLUMN pop_id TYPE TEXT;
ALTER TABLE fact_billing ALTER COLUMN package_id TYPE TEXT;

ALTER TABLE fact_collection ALTER COLUMN customer_id TYPE TEXT;
ALTER TABLE fact_collection ALTER COLUMN tran_id TYPE TEXT;
ALTER TABLE fact_collection ALTER COLUMN tran_mode_id TYPE TEXT;
ALTER TABLE fact_collection ALTER COLUMN pop_id TYPE TEXT;

ALTER TABLE fact_refund ALTER COLUMN customer_id TYPE TEXT;
ALTER TABLE fact_adjustment ALTER COLUMN customer_id TYPE TEXT;
