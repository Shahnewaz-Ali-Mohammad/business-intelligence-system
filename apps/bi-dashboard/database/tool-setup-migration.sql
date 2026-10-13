-- Application database only. This migration never targets a source database.
CREATE TABLE IF NOT EXISTS bi_tool_servers (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL,
  name VARCHAR(200) NOT NULL,
  encrypted_config TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bi_tool_sources (
  id VARCHAR(64) PRIMARY KEY,
  server_id VARCHAR(64) NOT NULL,
  database_name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  catalog_json MEDIUMTEXT NOT NULL,
  catalog_fingerprint CHAR(64) NOT NULL,
  discovered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY server_database (server_id, database_name),
  FOREIGN KEY (server_id) REFERENCES bi_tool_servers(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bi_generated_tools (
  id VARCHAR(64) PRIMARY KEY,
  source_id VARCHAR(64) NOT NULL,
  name VARCHAR(64) NOT NULL,
  definition_json TEXT NOT NULL,
  catalog_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  version INT NOT NULL DEFAULT 1,
  tested_hash CHAR(64) NULL,
  tested_at DATETIME NULL,
  approved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY source_tool_name (source_id, name),
  FOREIGN KEY (source_id) REFERENCES bi_tool_sources(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bi_tool_versions (
  tool_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  definition_json TEXT NOT NULL,
  catalog_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tool_id, version),
  FOREIGN KEY (tool_id) REFERENCES bi_generated_tools(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bi_tool_test_runs (
  id VARCHAR(64) PRIMARY KEY,
  tool_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  definition_hash CHAR(64) NOT NULL,
  catalog_fingerprint CHAR(64) NOT NULL,
  succeeded BOOLEAN NOT NULL,
  preview_count INT NOT NULL DEFAULT 0,
  has_more BOOLEAN NOT NULL DEFAULT FALSE,
  elapsed_ms INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tool_id) REFERENCES bi_generated_tools(id) ON DELETE CASCADE,
  INDEX tool_run_time (tool_id, created_at)
);
