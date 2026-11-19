CREATE TABLE "face_events" (
    "id" UUID NOT NULL,
    "device_id" UUID,
    "branch_id" UUID NOT NULL,
    "employee_no" TEXT NOT NULL,
    "member_id" UUID,
    "scanned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "face_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "face_events_branch_id_scanned_at_idx" ON "face_events"("branch_id", "scanned_at");

CREATE TABLE "face_jobs" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "claimed_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "face_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "face_jobs_device_id_status_idx" ON "face_jobs"("device_id", "status");
CREATE INDEX "face_jobs_member_id_idx" ON "face_jobs"("member_id");
