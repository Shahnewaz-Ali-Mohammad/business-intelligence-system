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
