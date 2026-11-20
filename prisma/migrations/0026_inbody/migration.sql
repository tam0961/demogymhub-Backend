CREATE TABLE "inbody_records" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "measured_on" DATE NOT NULL,
    "weight" DECIMAL(5,1) NOT NULL,
    "height" DECIMAL(5,1) NOT NULL,
    "body_fat" DECIMAL(4,1) NOT NULL,
    "muscle" DECIMAL(5,1) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inbody_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inbody_records_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inbody_records_range_chk" CHECK ("weight" BETWEEN 20 AND 300 AND "height" BETWEEN 100 AND 250 AND "body_fat" BETWEEN 1 AND 70 AND "muscle" BETWEEN 5 AND 150)
);
CREATE INDEX "inbody_records_member_id_measured_on_idx" ON "inbody_records"("member_id", "measured_on");
