CREATE TABLE "sheet_write_log" (
    "id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sheet_write_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sheet_write_log_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "group_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sheet_write_log_status_chk" CHECK ("status" IN ('pending','ok','failed','skipped'))
);
CREATE UNIQUE INDEX "sheet_write_log_registration_id_key" ON "sheet_write_log"("registration_id");
CREATE INDEX "sheet_write_log_status_idx" ON "sheet_write_log"("status");
