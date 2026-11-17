ALTER TABLE "packages" ADD COLUMN "bundle_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "packages" ADD COLUMN "gift" VARCHAR(200);
ALTER TABLE "packages" ADD COLUMN "checkin_before" VARCHAR(5);
