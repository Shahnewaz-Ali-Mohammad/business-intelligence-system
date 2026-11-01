-- Add publishing, audience sharing, and export preferences to existing reports.
-- Safe to re-run in phpMyAdmin. The application DB user cannot run ALTER/CREATE.
SET @has_published = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='designed_reports' AND COLUMN_NAME='published');
SET @sql = IF(@has_published=0, 'ALTER TABLE designed_reports ADD COLUMN published TINYINT(1) NOT NULL DEFAULT 0 AFTER updated_by', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_share_scope = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='designed_reports' AND COLUMN_NAME='share_scope');
SET @sql = IF(@has_share_scope=0, "ALTER TABLE designed_reports ADD COLUMN share_scope ENUM('private','workspace','selected') NOT NULL DEFAULT 'private' AFTER published", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_allow_export = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='designed_reports' AND COLUMN_NAME='allow_export');
SET @sql = IF(@has_allow_export=0, 'ALTER TABLE designed_reports ADD COLUMN allow_export TINYINT(1) NOT NULL DEFAULT 1 AFTER share_scope', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS designed_report_audiences (
  report_id INT UNSIGNED NOT NULL,
  audience_type ENUM('user', 'role', 'department') NOT NULL,
  audience_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (report_id, audience_type, audience_id),
  CONSTRAINT fk_designed_audiences_report FOREIGN KEY (report_id) REFERENCES designed_reports(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
