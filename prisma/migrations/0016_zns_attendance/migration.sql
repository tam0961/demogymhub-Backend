ALTER TABLE "users" ADD COLUMN "employee_no" TEXT;
CREATE UNIQUE INDEX "users_employee_no_key" ON "users"("employee_no");

CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "zns_logs" (
    "id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "member_id" UUID,
    "phone" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "zns_logs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "zns_logs_dedupe_key_key" ON "zns_logs"("dedupe_key");
CREATE INDEX "zns_logs_created_at_idx" ON "zns_logs"("created_at");

CREATE TABLE "staff_devices" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "device_key" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_devices_device_key_key" ON "staff_devices"("device_key");
ALTER TABLE "staff_devices" ADD CONSTRAINT "staff_devices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "staff_punches" (
    "id" UUID NOT NULL,
    "device_id" UUID,
    "user_id" UUID,
    "employee_no" TEXT NOT NULL,
    "punched_at" TIMESTAMPTZ NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'device',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_punches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_punches_device_id_employee_no_punched_at_key" ON "staff_punches"("device_id", "employee_no", "punched_at");
CREATE INDEX "staff_punches_user_id_punched_at_idx" ON "staff_punches"("user_id", "punched_at");
CREATE INDEX "staff_punches_punched_at_idx" ON "staff_punches"("punched_at");
ALTER TABLE "staff_punches" ADD CONSTRAINT "staff_punches_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "staff_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_punches" ADD CONSTRAINT "staff_punches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
