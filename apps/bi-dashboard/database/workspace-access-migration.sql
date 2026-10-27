-- Which departments may open which workspace. Run once in phpMyAdmin on bi_app.
-- The CEO and admins open every workspace; a workspace with no department is CEO/admin only.
CREATE TABLE IF NOT EXISTS workspace_departments (
  workspace_id  VARCHAR(64) NOT NULL,
  department_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (workspace_id, department_id),
  KEY idx_workspace_departments_department (department_id)
) ENGINE=InnoDB;
