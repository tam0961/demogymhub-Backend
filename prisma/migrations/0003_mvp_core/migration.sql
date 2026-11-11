CREATE TYPE "ContractStatus" AS ENUM ('draft', 'signed', 'active', 'frozen', 'expired', 'cancelled');
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'confirmed', 'failed', 'refunded');
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'transfer', 'vietqr', 'ewallet');

CREATE SEQUENCE contract_code_seq START 1000;

CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "member_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'draft',
    "total_amount" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "paid_amount" INTEGER NOT NULL DEFAULT 0,
    "duration_days" INTEGER,
    "start_date" DATE,
    "end_date" DATE,
    "sessions_total" INTEGER,
    "sessions_left" INTEGER,
    "signed_at" TIMESTAMPTZ,
    "signature_data" TEXT,
    "activated_at" TIMESTAMPTZ,
    "frozen_until" DATE,
    "renewed_from_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contracts_money_chk" CHECK ("total_amount" >= 0 AND "discount" >= 0 AND "paid_amount" >= 0)
);
CREATE UNIQUE INDEX "contracts_code_key" ON "contracts"("code");
CREATE INDEX "contracts_member_id_idx" ON "contracts"("member_id");
CREATE INDEX "contracts_branch_id_status_idx" ON "contracts"("branch_id", "status");
CREATE INDEX "contracts_end_date_idx" ON "contracts"("end_date");
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "contract_events" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "by_user" UUID,
    "reason" TEXT,
    "diff" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contract_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "contract_events_contract_id_created_at_idx" ON "contract_events"("contract_id", "created_at");
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION contract_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'contract_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contract_events_no_change BEFORE UPDATE OR DELETE ON "contract_events"
  FOR EACH ROW EXECUTE FUNCTION contract_events_append_only();

CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ,
    "opening_cash" INTEGER NOT NULL,
    "expected_cash" INTEGER,
    "counted_cash" INTEGER,
    "difference" INTEGER,
    "totals" JSONB,
    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shifts_cash_chk" CHECK ("opening_cash" >= 0)
);
CREATE INDEX "shifts_user_id_closed_at_idx" ON "shifts"("user_id", "closed_at");
CREATE INDEX "shifts_branch_id_idx" ON "shifts"("branch_id");
CREATE UNIQUE INDEX "shifts_one_open_per_user" ON "shifts"("user_id") WHERE "closed_at" IS NULL;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION shifts_immutable_when_closed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shifts cannot be deleted';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'closed shifts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER shifts_closed_guard BEFORE UPDATE OR DELETE ON "shifts"
  FOR EACH ROW EXECUTE FUNCTION shifts_immutable_when_closed();

CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "ref" TEXT NOT NULL,
    "shift_id" UUID,
    "refund_shift_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ,
    "confirmed_by" UUID,
    "refund_requested_at" TIMESTAMPTZ,
    "refund_requested_by" UUID,
    "refund_reason" TEXT,
    "refunded_at" TIMESTAMPTZ,
    "refunded_by" UUID,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_amount_chk" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "payments_ref_key" ON "payments"("ref");
CREATE INDEX "payments_contract_id_idx" ON "payments"("contract_id");
CREATE INDEX "payments_branch_id_confirmed_at_idx" ON "payments"("branch_id", "confirmed_at");
CREATE INDEX "payments_shift_id_idx" ON "payments"("shift_id");
ALTER TABLE "payments" ADD CONSTRAINT "payments_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "payment_webhook_deliveries" (
    "id" UUID NOT NULL,
    "ref" TEXT,
    "amount" INTEGER,
    "status_in" TEXT,
    "signature_ok" BOOLEAN NOT NULL,
    "result" TEXT NOT NULL,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkins" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "contract_id" UUID,
    "branch_id" UUID NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "checked_in_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_out_at" TIMESTAMPTZ,
    "override_by" UUID,
    "deducted" BOOLEAN NOT NULL DEFAULT false,
    "deducted_day" DATE,
    "created_by" UUID,
    CONSTRAINT "checkins_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checkins_contract_id_deducted_day_key" ON "checkins"("contract_id", "deducted_day");
CREATE INDEX "checkins_branch_id_checked_in_at_idx" ON "checkins"("branch_id", "checked_in_at");
CREATE INDEX "checkins_member_id_checked_in_at_idx" ON "checkins"("member_id", "checked_in_at");
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
