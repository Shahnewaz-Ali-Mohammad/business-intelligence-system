-- Keeps a conversation on its warehouse even before its first report.
-- Intentionally no workspace FK: removing a connection must fail closed,
-- not turn the conversation into an unrelated legacy-ISP chat.
SET @has_warehouse_id = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'chat_sessions' AND column_name = 'warehouse_id');
SET @warehouse_migration = IF(@has_warehouse_id = 0,
  'ALTER TABLE chat_sessions ADD COLUMN warehouse_id VARCHAR(64) NULL', 'SELECT 1');
PREPARE warehouse_stmt FROM @warehouse_migration;
EXECUTE warehouse_stmt;
DEALLOCATE PREPARE warehouse_stmt;
