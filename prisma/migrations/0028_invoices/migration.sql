CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "contract_id" UUID,
    "payment_id" UUID,
    "status" TEXT NOT NULL,
    "invoice_no" TEXT,
    "reservation_code" TEXT,
    "transaction_id" TEXT,
    "buyer_name" TEXT NOT NULL,
    "buyer_tax_code" TEXT,
    "net" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoices_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "invoices_contract_id_idx" ON "invoices"("contract_id");
