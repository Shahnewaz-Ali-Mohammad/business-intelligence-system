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
-- See the project's running decision-log doc, section 3.7, for the full confirmed
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

-- ============================================================================
-- PATCH 3 (2026-09-28): pre-aggregated POP rollup + covering indexes.
--
-- ROOT CAUSE of "the request took too long" on "all POPs, revenue, and
-- customer count per POP" type reports: fact_billing/fact_collection/
-- fact_refund/fact_adjustment.pop_id is ALWAYS NULL (see JOIN_DIMENSIONS'
-- own comment in src/semantic/metrics.mjs) -- the only real way to group
-- any of these tables by POP is a JOIN to dim_customer on customer_id.
-- getPopFinancials ran that join FOUR TIMES (once per metric), each one a
-- full scan of a multi-million-row fact table (fact_billing alone was
-- confirmed at 6.3M+ rows well before the 20M scale mentioned here),
-- joined to dim_customer, grouped by pop_id -- live, on every single
-- request, no matter how many times the same question gets asked. This
-- is exactly the "Pre-Aggregation" gap called out in the project's own
-- architecture doc (a dual-tier cache/pre-aggregation layer to keep
-- response times under 2s) -- it was never actually built. Bumping a
-- request timeout never fixes this: it only changes how long you wait
-- before the SAME unbounded scan either finishes or fails again, and it
-- gets strictly worse as more data is synced in.
--
-- THE FIX: pre-compute the join+aggregation ONCE, at ETL-sync time (see
-- refreshPopFinancialsRollup in src/etl/lib/materializedViews.mjs, wired
-- into src/etl/sync.mjs right after BillingMaster syncs), into a
-- materialized view keyed by (pop_id, ref_date) -- at most
-- (#pops x #distinct calendar days with activity) rows, i.e. a few tens of
-- thousands of rows total, regardless of whether the underlying fact
-- tables hold 20 million rows or 200 million. Any real user question
-- ("all POPs for the last 30 days", "top 30 POPs this quarter") then
-- aggregates over a SUM/GROUP BY on this small rollup instead of the raw
-- fact tables -- milliseconds instead of tens of seconds, and it stays
-- that fast as the warehouse grows, because the rollup's size is driven
-- by (POPs x days), not by transaction volume.
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mart_pop_daily_financials AS
SELECT
  pop_id,
  ref_date,
  SUM(billed) AS billed,
  SUM(collected) AS collected,
  SUM(refunded) AS refunded,
  SUM(adjusted) AS adjusted
FROM (
  SELECT dc.pop_id, f.ref_date, f.amount AS billed, 0::numeric AS collected, 0::numeric AS refunded, 0::numeric AS adjusted
  FROM fact_billing f
  JOIN dim_customer dc ON f.customer_id = dc.customer_id
  UNION ALL
  SELECT dc.pop_id, f.ref_date, 0::numeric, f.amount, 0::numeric, 0::numeric
  FROM fact_collection f
  JOIN dim_customer dc ON f.customer_id = dc.customer_id
  UNION ALL
  SELECT dc.pop_id, f.ref_date, 0::numeric, 0::numeric, f.amount, 0::numeric
  FROM fact_refund f
  JOIN dim_customer dc ON f.customer_id = dc.customer_id
  UNION ALL
  SELECT dc.pop_id, f.ref_date, 0::numeric, 0::numeric, 0::numeric, f.amount
  FROM fact_adjustment f
  JOIN dim_customer dc ON f.customer_id = dc.customer_id
) combined
GROUP BY pop_id, ref_date;

-- A materialized view has no PRIMARY KEY, but a UNIQUE index is what lets
-- REFRESH MATERIALIZED VIEW CONCURRENTLY run (see materializedViews.mjs) --
-- CONCURRENTLY means the nightly refresh never blocks a report that's
-- reading this view at that exact moment, which a plain REFRESH would.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mart_pop_daily_financials_pk ON mart_pop_daily_financials(pop_id, ref_date);
CREATE INDEX IF NOT EXISTS idx_mart_pop_daily_financials_date ON mart_pop_daily_financials(ref_date);

-- Covering indexes as a second layer of defense: any question this rollup
-- doesn't already answer (a breakdown this project adds later, an ad-hoc
-- date-range query, or a report run before the very first nightly refresh
-- populates the view) still hits the raw fact tables -- these let Postgres
-- satisfy a ref_date-range scan straight from the index (customer_id and
-- amount are carried in the index itself via INCLUDE, so a query that only
-- needs those two columns plus the range never has to touch the table's
-- actual heap pages at all).
CREATE INDEX IF NOT EXISTS idx_fact_billing_date_covering ON fact_billing(ref_date) INCLUDE (customer_id, amount);
CREATE INDEX IF NOT EXISTS idx_fact_collection_date_covering ON fact_collection(ref_date) INCLUDE (customer_id, amount);
CREATE INDEX IF NOT EXISTS idx_fact_refund_date_covering ON fact_refund(ref_date) INCLUDE (customer_id, amount);
CREATE INDEX IF NOT EXISTS idx_fact_adjustment_date_covering ON fact_adjustment(ref_date) INCLUDE (customer_id, amount);
