-- ============================================================================
-- bi_app: a NEW, SEPARATE database for this application's own data.
-- This is completely independent from `ecommerce` (the read-only business
-- database). Nothing here touches `ecommerce`, and the new `bi_app_user`
-- below is granted access ONLY to `bi_app` -- never to `ecommerce`.
-- Run this once with a MySQL account that can create databases/users
-- (e.g. root in phpMyAdmin's SQL tab, or `mysql -u root -p < bi_app_schema.sql`).
-- ============================================================================

CREATE DATABASE IF NOT EXISTS bi_app
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- Dedicated read-write user, scoped ONLY to bi_app. Change this password
-- before running in anything but local dev, then update .env.local to match.
CREATE USER IF NOT EXISTS 'bi_app_user'@'localhost' IDENTIFIED BY 'REPLACE_WITH_APP_DB_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE ON bi_app.* TO 'bi_app_user'@'localhost';
FLUSH PRIVILEGES;

USE bi_app;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(120) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  token       CHAR(64) PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  role        ENUM('user', 'assistant') NOT NULL,
  content     TEXT NOT NULL,
  tables_used JSON NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_created (user_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS generated_reports (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  title       VARCHAR(255) NOT NULL,
  narrative   TEXT NOT NULL,
  filters     JSON NULL,
  tables_used JSON NULL,
  data        JSON NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_created (user_id, created_at)
) ENGINE=InnoDB;

-- ============================================================================
-- Migration: group chat_messages into real conversations (chat_sessions).
-- Safe to re-run: uses IF NOT EXISTS everywhere.
-- ============================================================================
USE bi_app;

CREATE TABLE IF NOT EXISTS chat_sessions (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  title       VARCHAR(255) NOT NULL DEFAULT 'New conversation',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_updated (user_id, updated_at)
) ENGINE=InnoDB;

-- Backfill: every existing message that predates chat_sessions gets grouped
-- into one legacy session per user, so nothing is lost.
SET @has_session_col = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_messages' AND COLUMN_NAME = 'session_id'
);

SET @sql_add_col = IF(@has_session_col = 0,
  'ALTER TABLE chat_messages ADD COLUMN session_id INT UNSIGNED NULL AFTER user_id',
  'SELECT 1');
PREPARE stmt FROM @sql_add_col;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT INTO chat_sessions (user_id, title, created_at, updated_at)
SELECT DISTINCT user_id, 'Earlier conversation', MIN(created_at) OVER (PARTITION BY user_id), MAX(created_at) OVER (PARTITION BY user_id)
FROM chat_messages
WHERE session_id IS NULL
  AND user_id NOT IN (SELECT DISTINCT user_id FROM chat_sessions WHERE title = 'Earlier conversation');

UPDATE chat_messages m
JOIN chat_sessions s ON s.user_id = m.user_id AND s.title = 'Earlier conversation'
SET m.session_id = s.id
WHERE m.session_id IS NULL;

SET @has_fk = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_messages' AND COLUMN_NAME = 'session_id' AND REFERENCED_TABLE_NAME = 'chat_sessions'
);
SET @sql_add_fk = IF(@has_fk = 0,
  'ALTER TABLE chat_messages ADD CONSTRAINT fk_chat_messages_session FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE, ADD INDEX idx_session (session_id)',
  'SELECT 1');
PREPARE stmt FROM @sql_add_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- Migration: remember which topic/chart format a saved report was generated
-- as, so re-opening a saved report renders the SAME chart it showed when it
-- was generated (customers/products/status/pie/line/etc), instead of the
-- report detail page always falling back to a fixed Revenue by Region +
-- Revenue Over Time pair. Safe to re-run: uses IF NOT EXISTS everywhere.
-- ============================================================================
USE bi_app;

SET @has_topic_col = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND COLUMN_NAME = 'topic'
);
SET @sql_add_topic = IF(@has_topic_col = 0,
  'ALTER TABLE generated_reports ADD COLUMN topic VARCHAR(40) NULL AFTER narrative',
  'SELECT 1');
PREPARE stmt FROM @sql_add_topic;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_chart_type_col = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND COLUMN_NAME = 'chart_type'
);
SET @sql_add_chart_type = IF(@has_chart_type_col = 0,
  'ALTER TABLE generated_reports ADD COLUMN chart_type VARCHAR(20) NULL AFTER topic',
  'SELECT 1');
PREPARE stmt FROM @sql_add_chart_type;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================================
-- Migration: track real report exports (downloads) instead of showing a
-- fixed, fake list on the Exports page. Every time a user actually clicks
-- "Export CSV"/"Export Excel" on a report, one row is logged here; the
-- Exports page reads this table and shows nothing until a real export
-- has happened. Safe to re-run: uses IF NOT EXISTS everywhere.
-- ============================================================================
USE bi_app;

CREATE TABLE IF NOT EXISTS report_exports (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  report_id   INT UNSIGNED NULL,
  file_name   VARCHAR(255) NOT NULL,
  format      VARCHAR(10) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (report_id) REFERENCES generated_reports(id) ON DELETE SET NULL,
  INDEX idx_user_created (user_id, created_at)
) ENGINE=InnoDB;

-- ============================================================================
-- Migration: store the exported file's own content alongside the log entry,
-- so a re-download from the Exports page always reproduces the exact file
-- that was originally exported -- even if the source report is later
-- edited or deleted. Safe to re-run: uses IF NOT EXISTS everywhere.
-- ============================================================================
USE bi_app;

SET @has_file_content_col = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'report_exports' AND COLUMN_NAME = 'file_content'
);
SET @sql_add_file_content = IF(@has_file_content_col = 0,
  'ALTER TABLE report_exports ADD COLUMN file_content LONGTEXT NULL AFTER format',
  'SELECT 1');
PREPARE stmt FROM @sql_add_file_content;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- Migration: persist the chart alongside a saved report, not just the
-- table. Stores the EDITED chart spec (chart type, which measure columns
-- are visible, how many rows) as JSON -- never a rendered image -- so
-- reopening a saved report brings back the exact chart it was left in,
-- still further editable. A report saved before this column existed (or
-- never edited since) has chart_spec = NULL; the app falls back to
-- re-deriving a default chart on the fly from that report's own `data`
-- (getChartSpec), the same "don't require a backfill, just degrade
-- gracefully off what's already stored" pattern topic/chart_type used
-- above. Safe to re-run: uses IF NOT EXISTS everywhere.
-- ============================================================================
USE bi_app;

SET @has_chart_spec_col = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND COLUMN_NAME = 'chart_spec'
);
SET @sql_add_chart_spec = IF(@has_chart_spec_col = 0,
  'ALTER TABLE generated_reports ADD COLUMN chart_spec JSON NULL AFTER data',
  'SELECT 1');
PREPARE stmt FROM @sql_add_chart_spec;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================================
-- Migration: persist the report (table + chart) generated for a chat
-- message, not just its text. Previously chat_messages only stored the
-- narrative -- reopening a saved conversation (Recent Chats / Sessions)
-- showed the old text but never the table/chart that went with it, even
-- though it clearly existed when the message was first sent. Stores the
-- SAME shape the chat UI already builds an inline report from (title,
-- narrative, topic, chartType, data, days, region, tablesUsed) as one JSON
-- blob on the assistant message that generated it, so reopening a chat can
-- render every one of its reports exactly as they looked originally, not
-- just the latest one. NULL for a message that never had a report (a plain
-- answer) or one saved before this column existed. Safe to re-run: uses
-- IF NOT EXISTS everywhere.
-- ============================================================================
USE bi_app;

SET @has_report_data_col = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_messages' AND COLUMN_NAME = 'report_data'
);
SET @sql_add_report_data = IF(@has_report_data_col = 0,
  'ALTER TABLE chat_messages ADD COLUMN report_data JSON NULL AFTER tables_used',
  'SELECT 1');
PREPARE stmt FROM @sql_add_report_data;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- Migration: multi-tenant workspaces -- lets this system connect to more
-- than one customer database instead of being hardcoded to the ISP's
-- billGENIXDB/TicketingDB. A "workspace" is one customer's data: its own
-- source connection (encrypted, never stored in plain text), its own
-- synced warehouse copy (Postgres, schema `workspace_<id>`, populated by
-- apps/bi-warehouse/src/sync/syncWorkspace.mjs -- never the source DB
-- queried live), and its own AI-drafted + human-confirmed semantic model.
--
-- The existing ISP system keeps working completely unchanged: its tables,
-- MCP tools, and chat agent are untouched by this migration. A row is
-- seeded below (id = 'isp-default') so the current production data has a
-- workspace identity too, without needing anyone to re-onboard it.
-- Safe to re-run: uses IF NOT EXISTS everywhere, matching every other
-- migration in this file.
-- ============================================================================
USE bi_app;

CREATE TABLE IF NOT EXISTS workspaces (
  id            VARCHAR(64) PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  owner_user_id INT UNSIGNED NOT NULL,
  ai_system_prompt TEXT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS workspace_connections (
  workspace_id       VARCHAR(64) PRIMARY KEY,
  dialect            VARCHAR(32) NOT NULL,
  host               VARCHAR(255) NOT NULL,
  port               INT NOT NULL,
  database_name      VARCHAR(255) NOT NULL,
  encrypted_conn_string TEXT NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS workspace_semantic_models (
  workspace_id   VARCHAR(64) PRIMARY KEY,
  status         ENUM('none', 'drafted', 'confirmed') NOT NULL DEFAULT 'none',
  draft_yaml     LONGTEXT NULL,
  confirmed_yaml LONGTEXT NULL,
  drafted_at     DATETIME NULL,
  confirmed_at   DATETIME NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS workspace_sync_runs (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL,
  status       ENUM('running', 'succeeded', 'failed') NOT NULL DEFAULT 'running',
  started_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at  DATETIME NULL,
  rows_synced  INT UNSIGNED NULL,
  error        TEXT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  INDEX idx_workspace_started (workspace_id, started_at)
) ENGINE=InnoDB;

INSERT IGNORE INTO workspaces (id, name, owner_user_id)
SELECT 'isp-default', 'ISP (existing production)', MIN(id) FROM users;

-- ============================================================================
-- Migration 2026-10-01: report history/versioning. A saved report used to
-- be a dead end -- no record of the question that produced it, and no way
-- to ask a follow-up ("now just Dhaka") and get a new report that's
-- clearly a continuation of the first, not an unrelated one. Two columns:
-- `context` (the question + a short prior-turn history that produced this
-- report -- NOT the full chat session, just enough to hand back to the
-- agent as conversational context for a regenerate) and `parent_report_id`
-- (self-referencing -- set only when this report was created via
-- "Regenerate" from another saved report, forming a version chain). A
-- report saved before this migration has both NULL -- it's simply a report
-- with no recorded history and no parent, same degrade-gracefully pattern
-- as chart_spec above. ON DELETE SET NULL (not CASCADE) on the self-FK:
-- deleting a parent report must never delete its children's history, it
-- just orphans them to "no parent" -- a child report is a real, independently
-- saved report in its own right. Safe to re-run: uses IF NOT EXISTS everywhere.
-- ============================================================================
USE bi_app;

SET @has_context_col = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND COLUMN_NAME = 'context'
);
SET @sql_add_context = IF(@has_context_col = 0,
  'ALTER TABLE generated_reports ADD COLUMN context JSON NULL AFTER chart_spec',
  'SELECT 1');
PREPARE stmt FROM @sql_add_context;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_parent_col = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND COLUMN_NAME = 'parent_report_id'
);
SET @sql_add_parent = IF(@has_parent_col = 0,
  'ALTER TABLE generated_reports ADD COLUMN parent_report_id INT UNSIGNED NULL AFTER context',
  'SELECT 1');
PREPARE stmt FROM @sql_add_parent;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_parent_fk = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND CONSTRAINT_NAME = 'fk_generated_reports_parent'
);
SET @sql_add_parent_fk = IF(@has_parent_fk = 0,
  'ALTER TABLE generated_reports ADD CONSTRAINT fk_generated_reports_parent FOREIGN KEY (parent_report_id) REFERENCES generated_reports(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql_add_parent_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_parent_idx = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND INDEX_NAME = 'idx_parent_report_id'
);
SET @sql_add_parent_idx = IF(@has_parent_idx = 0,
  'ALTER TABLE generated_reports ADD INDEX idx_parent_report_id (parent_report_id)',
  'SELECT 1');
PREPARE stmt FROM @sql_add_parent_idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- Migration 2026-10-03: link a saved report back to the real chat session
-- it was generated from, instead of snapshotting a frozen copy of the
-- conversation (the `context`/`parent_report_id` columns added 2026-10-01,
-- now unused -- left in place rather than dropped, since dropping a column
-- is a one-way, higher-risk change and these are harmless sitting empty).
-- A snapshot goes stale the moment the real conversation moves on, and
-- regenerating from it needs a second code path that duplicates the real
-- chat pipeline's own logic -- exactly the kind of duplicated logic that
-- caused the column-selection bug fixed the same week (two copies of the
-- same list, one forgotten to update). Linking to the real session instead
-- means "continue this report's conversation" is just opening /chat?session=X,
-- the actual, full, untruncated conversation, with zero duplicated logic.
-- ON DELETE SET NULL (not CASCADE): deleting a chat session must never
-- delete a report someone saved from it -- the report stands on its own,
-- it just loses the "continue in chat" link. Safe to re-run: uses IF NOT
-- EXISTS everywhere.
-- ============================================================================
USE bi_app;

SET @has_source_session_col = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND COLUMN_NAME = 'source_session_id'
);
SET @sql_add_source_session = IF(@has_source_session_col = 0,
  'ALTER TABLE generated_reports ADD COLUMN source_session_id INT UNSIGNED NULL AFTER parent_report_id',
  'SELECT 1');
PREPARE stmt FROM @sql_add_source_session;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_source_session_fk = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND CONSTRAINT_NAME = 'fk_generated_reports_source_session'
);
SET @sql_add_source_session_fk = IF(@has_source_session_fk = 0,
  'ALTER TABLE generated_reports ADD CONSTRAINT fk_generated_reports_source_session FOREIGN KEY (source_session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql_add_source_session_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_source_session_idx = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_reports' AND INDEX_NAME = 'idx_source_session_id'
);
SET @sql_add_source_session_idx = IF(@has_source_session_idx = 0,
  'ALTER TABLE generated_reports ADD INDEX idx_source_session_id (source_session_id)',
  'SELECT 1');
PREPARE stmt FROM @sql_add_source_session_idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- A removed warehouse must not silently redirect its chats to ISP data.
SET @has_warehouse_id = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'chat_sessions' AND column_name = 'warehouse_id');
SET @warehouse_migration = IF(@has_warehouse_id = 0,
  'ALTER TABLE chat_sessions ADD COLUMN warehouse_id VARCHAR(64) NULL', 'SELECT 1');
PREPARE warehouse_stmt FROM @warehouse_migration;
EXECUTE warehouse_stmt;
DEALLOCATE PREPARE warehouse_stmt;
