CREATE TABLE "staff_profiles" (
    "user_id" UUID NOT NULL,
    "phone" TEXT,
    "position" TEXT NOT NULL DEFAULT 'other',
    "hired_on" DATE,
    "left_on" DATE,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "staff_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- One profile per staff user: a role of trainer, sales, receptionist, branch_manager or manager.
-- A payroll profile (migration 0022) wins for position and active.
INSERT INTO "staff_profiles" ("user_id", "position", "active")
SELECT DISTINCT ON (u.id)
  u.id,
  COALESCE(
    pp.position,
    CASE r.key
      WHEN 'trainer' THEN 'pt_fulltime'
      WHEN 'sales' THEN 'sale'
      WHEN 'receptionist' THEN 'reception'
      ELSE 'other'
    END
  ),
  COALESCE(pp.active, true)
FROM users u
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r ON r.id = ur.role_id
LEFT JOIN payroll_profiles pp ON pp.user_id = u.id
WHERE u.status = 'active'
  AND r.key IN ('trainer', 'sales', 'receptionist', 'branch_manager', 'manager')
  AND (ur.expires_at IS NULL OR ur.expires_at > now())
ORDER BY u.id, CASE r.key WHEN 'trainer' THEN 1 WHEN 'sales' THEN 2 WHEN 'receptionist' THEN 3 ELSE 4 END;
