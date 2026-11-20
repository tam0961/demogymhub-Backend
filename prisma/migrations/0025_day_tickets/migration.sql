ALTER TABLE "payments" ALTER COLUMN "contract_id" DROP NOT NULL;
ALTER TABLE "payments" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'contract';
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_chk" CHECK (("kind" = 'contract' AND "contract_id" IS NOT NULL) OR "kind" = 'retail');

CREATE TABLE "day_tickets" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "issued_on" DATE NOT NULL,
    "checked_out_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "day_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "day_tickets_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "day_tickets_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "day_tickets_payment_id_key" ON "day_tickets"("payment_id");
CREATE INDEX "day_tickets_branch_id_issued_on_idx" ON "day_tickets"("branch_id", "issued_on");
CREATE INDEX "day_tickets_phone_issued_on_idx" ON "day_tickets"("phone", "issued_on");
