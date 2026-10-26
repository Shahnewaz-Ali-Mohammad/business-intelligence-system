# Discontinue Summary Failure And Fix

## Confirmed Cause

Failed run: 74009249-f716-47eb-ac74-74ac4c8be519, dbo.rpt_DiscontinueSummary, chat session 168.

The browser supplied datetime values with minute precision: 2025-03-18T16:37 and 2026-10-18T16:37. Retrying the already-approved, verified read-only procedure with error handling enabled reproduced SQL Server error 8114 (EREQUEST): "Error converting data type nvarchar(max) to datetime."

The runner sends temporal inputs as bound text to preserve precision. SQL Server rejected these minute-only strings at its datetime RPC conversion boundary. Separately, the mssql streaming request had no error listener, so the emitted SQL error terminated the worker instead of reaching the normal failure handler. The launcher discarded stderr, losing the diagnostic.

## Changes

- Normalize minute-only temporal values to include seconds. Normalize date-only datetime values to midnight, without converting through JavaScript Date or losing datetime2 fractions or offsets.
- Capture SQL request and connection-pool error events, fail the report explicitly, and close the connection.
- Retain worker output in each run's private worker.log file, and persist process exit code/signal for unexpected exits.
- Add regression tests for temporal binding and streamed errors, including the mssql behavior where execute resolves after emitting an error.

## Live Verification

- Used the same original dates and existing approval, with allowBusinessWrites=false.
- Executed through the actual app endpoint on port 3000 in existing chat session 168.
- New run: af7c3fe0-9f45-4b99-bd5c-1f922717b1eb.
- Completed, return code 0, one table and one row, with NoOfPending=63458 and NoOfCompleted=33132.
- Columns: NoOfPending, NoOfCompleted, StartDate, EndDate, Duration.
- Full selected automated suite: 218 passed, zero failed. Focused lint checks passed.
- No source records, tables, schemas, or stored-procedure definitions were changed.

The original failed attempt remains in history. A successful new reply is appended to the same chat rather than rewriting that failure.

The procedure's existing SQL counts pending customers without a date predicate, while completed customers are filtered by the supplied dates. This behavior was observed but not modified.
