CREATE TYPE "PtSessionStatus" AS ENUM ('scheduled', 'completed', 'cancelled', 'no_show');

CREATE TABLE "pt_sessions" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "member_id" UUID,
    "contract_id" UUID,
    "start_at" TIMESTAMPTZ NOT NULL,
    "end_at" TIMESTAMPTZ NOT NULL,
    "status" "PtSessionStatus" NOT NULL DEFAULT 'scheduled',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "completed_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "pt_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pt_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "pt_sessions_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "pt_sessions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "pt_sessions_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "pt_sessions_time_check" CHECK ("end_at" > "start_at")
);

CREATE INDEX "pt_sessions_branch_id_start_at_idx" ON "pt_sessions"("branch_id", "start_at");
CREATE INDEX "pt_sessions_trainer_id_start_at_idx" ON "pt_sessions"("trainer_id", "start_at");
CREATE INDEX "pt_sessions_member_id_idx" ON "pt_sessions"("member_id");

CREATE TYPE "GroupClassStatus" AS ENUM ('scheduled', 'completed', 'cancelled');
CREATE TYPE "GroupRegStatus" AS ENUM ('booked', 'attended', 'cancelled');

CREATE TABLE "group_classes" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "trainer_id" UUID,
    "title" TEXT NOT NULL DEFAULT 'PT nhóm',
    "start_at" TIMESTAMPTZ NOT NULL,
    "end_at" TIMESTAMPTZ NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 3,
    "status" "GroupClassStatus" NOT NULL DEFAULT 'scheduled',
    "completed_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "group_classes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "group_classes_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "group_classes_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "group_classes_time_check" CHECK ("end_at" > "start_at")
);
CREATE INDEX "group_classes_branch_id_start_at_idx" ON "group_classes"("branch_id", "start_at");

CREATE TABLE "group_registrations" (
    "id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "contract_id" UUID,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "status" "GroupRegStatus" NOT NULL DEFAULT 'booked',
    "deducted" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "cancelled_at" TIMESTAMPTZ,
    CONSTRAINT "group_registrations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "group_registrations_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "group_classes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "group_registrations_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "group_registrations_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "group_registrations_class_id_idx" ON "group_registrations"("class_id");
CREATE INDEX "group_registrations_member_id_idx" ON "group_registrations"("member_id");
CREATE UNIQUE INDEX "group_registrations_class_member_live" ON "group_registrations"("class_id", "member_id") WHERE "status" <> 'cancelled';
