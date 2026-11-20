ALTER TABLE "leads" ADD COLUMN "ext" TEXT;
CREATE UNIQUE INDEX "leads_ext_key" ON "leads"("ext");

CREATE TABLE "marketing_campaigns" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branch_id" UUID,
    "budget" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'paused',
    "kind" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "marketing_campaigns_platform_idx" ON "marketing_campaigns"("platform");

CREATE TABLE "marketing_daily" (
    "date" DATE NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "spend" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "msgs" INTEGER NOT NULL DEFAULT 0,
    "conv" DOUBLE PRECISION NOT NULL DEFAULT 0,
    CONSTRAINT "marketing_daily_pkey" PRIMARY KEY ("date", "campaign_id"),
    CONSTRAINT "marketing_daily_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "marketing_daily_date_idx" ON "marketing_daily"("date");
