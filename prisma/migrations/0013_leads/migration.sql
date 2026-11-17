CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'trial_booked', 'converted', 'lost');

CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "source" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "note" TEXT,
    "branch_id" UUID NOT NULL,
    "assigned_to" UUID,
    "trial_at" TIMESTAMPTZ,
    "member_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "leads_branch_id_status_idx" ON "leads"("branch_id", "status");
