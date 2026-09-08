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
CREATE USER IF NOT EXISTS 'bi_app_user'@'localhost' IDENTIFIED BY 'bi_app_password';
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
