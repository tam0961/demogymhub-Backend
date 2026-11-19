ALTER TYPE "PaymentMethod" ADD VALUE 'card';

-- Refunds from tickets are stored as negative payments (the old app: "so am la hoan tien"), so zero is the only forbidden amount.
ALTER TABLE "payments" DROP CONSTRAINT "payments_amount_chk";
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_chk" CHECK ("amount" <> 0);

CREATE TABLE "contract_tickets" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "requested_by" UUID,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contract_tickets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "contract_tickets_contract_id_idx" ON "contract_tickets"("contract_id");
CREATE INDEX "contract_tickets_status_created_at_idx" ON "contract_tickets"("status", "created_at");
ALTER TABLE "contract_tickets" ADD CONSTRAINT "contract_tickets_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
