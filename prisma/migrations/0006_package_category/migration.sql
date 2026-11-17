CREATE TYPE "PackageCategory" AS ENUM ('member', 'pt_1on1', 'pt_1on2', 'pt_group');

ALTER TABLE "packages" ADD COLUMN "category" "PackageCategory" NOT NULL DEFAULT 'member';
ALTER TABLE "packages" ADD COLUMN "bundled_member_package_id" UUID;
ALTER TABLE "packages" ADD COLUMN "replaces_id" UUID;

UPDATE "packages" SET "category" = CASE
  WHEN "name" ~* '(^|[^a-z])pt([^a-z]|$)' AND "name" ~* 'nhóm' THEN 'pt_group'::"PackageCategory"
  WHEN "name" ~* '(^|[^a-z])pt([^a-z]|$)' AND "name" ~* '(cặp đôi|cap doi|1:2)' THEN 'pt_1on2'::"PackageCategory"
  WHEN "name" ~* '(^|[^a-z])pt([^a-z]|$)' THEN 'pt_1on1'::"PackageCategory"
  WHEN "name" ~* '(lớp|lop |class|starter|yoga|zumba|pilates)' THEN 'pt_group'::"PackageCategory"
  ELSE 'member'::"PackageCategory"
END;

ALTER TABLE "packages" ADD CONSTRAINT "packages_bundled_member_package_id_fkey" FOREIGN KEY ("bundled_member_package_id") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "packages" ADD CONSTRAINT "packages_replaces_id_fkey" FOREIGN KEY ("replaces_id") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "packages_category_idx" ON "packages"("category");

ALTER TABLE "contracts" ADD COLUMN "bundle_of_id" UUID;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_bundle_of_id_fkey" FOREIGN KEY ("bundle_of_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "contracts_bundle_of_id_idx" ON "contracts"("bundle_of_id");

ALTER TABLE "contracts" ADD COLUMN "package_name" TEXT;
UPDATE "contracts" c SET "package_name" = p."name" FROM "packages" p WHERE p."id" = c."package_id";
