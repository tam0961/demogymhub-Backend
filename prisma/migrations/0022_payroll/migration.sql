CREATE TABLE "payroll_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "position" TEXT NOT NULL DEFAULT 'other',
    "base_salary" INTEGER NOT NULL DEFAULT 0,
    "has_insurance" BOOLEAN NOT NULL DEFAULT false,
    "tax_mode" TEXT NOT NULL DEFAULT 'none',
    "dependents" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payroll_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payroll_profiles_user_id_key" ON "payroll_profiles"("user_id");
ALTER TABLE "payroll_profiles" ADD CONSTRAINT "payroll_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payroll_adjustments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "penalty" INTEGER NOT NULL DEFAULT 0,
    "adjustment" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payroll_adjustments_user_id_month_key" ON "payroll_adjustments"("user_id", "month");
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payroll_periods" (
    "id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "snapshot" JSONB,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ,
    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payroll_periods_month_key" ON "payroll_periods"("month");
