CREATE TABLE "pt_day_off" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pt_day_off_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pt_day_off_trainer_id_branch_id_date_key" ON "pt_day_off"("trainer_id", "branch_id", "date");
CREATE INDEX "pt_day_off_branch_id_date_idx" ON "pt_day_off"("branch_id", "date");
ALTER TABLE "pt_day_off" ADD CONSTRAINT "pt_day_off_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pt_day_off" ADD CONSTRAINT "pt_day_off_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
