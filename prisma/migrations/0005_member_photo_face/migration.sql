ALTER TABLE "members" ADD COLUMN "face_id" TEXT;
CREATE UNIQUE INDEX "members_face_id_key" ON "members"("face_id");

CREATE TABLE "member_photos" (
    "member_id" UUID NOT NULL,
    "content_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "member_photos_pkey" PRIMARY KEY ("member_id"),
    CONSTRAINT "member_photos_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
