ALTER TABLE "contracts" ADD COLUMN "sale_user_id" UUID, ADD COLUMN "sale_name" TEXT, ADD COLUMN "pt_user_id" UUID, ADD COLUMN "pt_name" TEXT;
CREATE INDEX "contracts_pt_user_id_idx" ON "contracts"("pt_user_id");
