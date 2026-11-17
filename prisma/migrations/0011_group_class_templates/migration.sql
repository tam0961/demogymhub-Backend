ALTER TABLE "group_classes" ADD COLUMN "muscle_group" TEXT;

CREATE TABLE "group_class_templates" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 3,
    "muscle_group" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "group_class_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "group_class_templates_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7)
);
CREATE UNIQUE INDEX "group_class_templates_branch_id_weekday_start_time_key" ON "group_class_templates"("branch_id", "weekday", "start_time");
