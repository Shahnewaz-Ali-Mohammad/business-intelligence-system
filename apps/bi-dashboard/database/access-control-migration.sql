-- Roles, departments, invitations, data access rules and the audit log.
-- Applied automatically by the app on first use (lib/access/access-db.ts);
-- kept here so it can also be run by hand.

ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at DATETIME NULL;

CREATE TABLE IF NOT EXISTS departments (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  parent_id  INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_department_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INT UNSIGNED NOT NULL,
  role    VARCHAR(20) NOT NULL,
  PRIMARY KEY (user_id, role)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_departments (
  user_id       INT UNSIGNED NOT NULL,
  department_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, department_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invitations (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email          VARCHAR(255) NOT NULL,
  token_hash     CHAR(64) NOT NULL UNIQUE,
  roles          JSON NOT NULL,
  department_ids JSON NOT NULL,
  invited_by     INT UNSIGNED NOT NULL,
  expires_at     DATETIME NOT NULL,
  used_at        DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_invitation_email (email)
) ENGINE=InnoDB;

-- One rule set per connected database (bi_tool_sources.id).
CREATE TABLE IF NOT EXISTS data_policies (
  source_id  VARCHAR(64) PRIMARY KEY,
  source_key VARCHAR(400) NOT NULL,
  policy     JSON NOT NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_policy_source_key (source_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NULL,
  action     VARCHAR(60) NOT NULL,
  target     VARCHAR(255) NULL,
  details    JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_time (created_at),
  KEY idx_audit_user (user_id, created_at)
) ENGINE=InnoDB;
