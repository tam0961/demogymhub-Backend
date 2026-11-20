ALTER TABLE "contracts" ADD COLUMN "payment_due_date" DATE;

UPDATE "contracts"
SET "payment_due_date" = ("created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 25
WHERE "status" NOT IN ('draft', 'cancelled') AND "paid_amount" < "total_amount";
