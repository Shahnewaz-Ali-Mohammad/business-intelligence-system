-- Roles, departments, invitations, data access rules and the audit log.
-- Applied automatically by the app on first use (lib/access/access-db.ts);
-- kept here so it can also be run by hand.

-- Kept in its own table so the app never needs to ALTER the users table.
CREATE TABLE IF NOT EXISTS user_status (
  user_id     INT UNSIGNED PRIMARY KEY,
  disabled_at DATETIME NULL
) ENGINE=InnoDB;

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

-- Two-step sign-in: the authenticator secret (encrypted) per person, and
-- password-checked sign-ins waiting for their 6-digit code.
CREATE TABLE IF NOT EXISTS user_mfa (
  user_id    INT UNSIGNED PRIMARY KEY,
  secret     TEXT NOT NULL,
  enabled_at DATETIME NULL,
  last_step  BIGINT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pending_logins (
  token_hash CHAR(64) PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL
) ENGINE=InnoDB;

-- First install only: every existing user becomes Admin + CEO, so nobody is
-- locked out. Adjust people afterwards on the Admin > Users page.
INSERT INTO user_roles (user_id, role)
SELECT u.id, r.role FROM users u CROSS JOIN (SELECT 'admin' AS role UNION ALL SELECT 'ceo') r
WHERE NOT EXISTS (SELECT 1 FROM user_roles);

-- The app's own database user needs read/write on these tables (not DDL).
-- Which departments may open which workspace. Run once in phpMyAdmin on bi_app.
-- The CEO and admins open every workspace; a workspace with no department is CEO/admin only.
CREATE TABLE IF NOT EXISTS workspace_departments (
  workspace_id  VARCHAR(64) NOT NULL,
  department_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (workspace_id, department_id),
  KEY idx_workspace_departments_department (department_id)
) ENGINE=InnoDB;

-- Customer-support enquiry queue. Conversations are kept separate from BI chat.
CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  requester_user_id INT UNSIGNED NULL,
  subject VARCHAR(240) NOT NULL,
  status ENUM('open','in_progress','waiting_on_customer','resolved','closed') NOT NULL DEFAULT 'open',
  priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  assigned_to INT UNSIGNED NULL,
  source_workspace_id VARCHAR(64) NULL,
  language VARCHAR(20) NULL,
  ai_summary TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_support_status (status, updated_at), KEY idx_support_assignee (assigned_to, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  author_user_id INT UNSIGNED NULL,
  author_type ENUM('customer','ai','agent','system') NOT NULL,
  body MEDIUMTEXT NOT NULL,
  language VARCHAR(20) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_support_messages_ticket (ticket_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS support_knowledge_entries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NULL,
  question TEXT NOT NULL,
  approved_answer MEDIUMTEXT NOT NULL,
  approved_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_support_knowledge_ticket (ticket_id)
) ENGINE=InnoDB;
