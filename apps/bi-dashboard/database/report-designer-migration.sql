-- Report Designer: designed reports, their design chat, and saved versions.
-- Import once in phpMyAdmin (the app user cannot create tables).
CREATE TABLE IF NOT EXISTS designed_reports (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL,
  title VARCHAR(200) NOT NULL DEFAULT 'Untitled report',
  spec_json MEDIUMTEXT NOT NULL,
  messages_json MEDIUMTEXT NOT NULL,
  created_by INT NOT NULL,
  updated_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_designed_workspace (workspace_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS designed_report_versions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  report_id INT UNSIGNED NOT NULL,
  spec_json MEDIUMTEXT NOT NULL,
  note VARCHAR(300) NOT NULL DEFAULT '',
  created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_designed_versions (report_id, id),
  CONSTRAINT fk_designed_versions FOREIGN KEY (report_id) REFERENCES designed_reports(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
