DELETE FROM "user_roles" a USING "user_roles" b
WHERE a.ctid < b.ctid AND a.user_id = b.user_id AND a.role_id = b.role_id AND a.branch_id IS NOT DISTINCT FROM b.branch_id;

CREATE UNIQUE INDEX "user_roles_user_id_role_id_branch_id_key" ON "user_roles"("user_id", "role_id", "branch_id");
CREATE UNIQUE INDEX "user_roles_user_id_role_id_global_key" ON "user_roles"("user_id", "role_id") WHERE "branch_id" IS NULL;
