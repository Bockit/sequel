-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "job_state" AS ENUM ('queued', 'running', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "metric_kind" AS ENUM ('temperature', 'humidity', 'wind_speed');

-- CreateEnum
CREATE TYPE "alert_level" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "display_theme" AS ENUM ('light', 'dark', 'high-contrast');

-- CreateTable
CREATE TABLE "document" (
    "id" SERIAL NOT NULL,
    "station_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "embedding" vector(3),

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "state" "job_state" NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMPTZ(3),

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_peak" (
    "id" SERIAL NOT NULL,
    "station_id" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "metric" "metric_kind" NOT NULL,
    "peak" DOUBLE PRECISION NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_peak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reading" (
    "id" BIGSERIAL NOT NULL,
    "station_id" INTEGER NOT NULL,
    "metric" "metric_kind" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,

    CONSTRAINT "reading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "region" (
    "id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "name" TEXT NOT NULL,

    CONSTRAINT "region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "station" (
    "id" SERIAL NOT NULL,
    "region_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "station_alert_config" (
    "id" SERIAL NOT NULL,
    "station_id" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "level" "alert_level" NOT NULL DEFAULT 'warning',

    CONSTRAINT "station_alert_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "station_display_config" (
    "id" SERIAL NOT NULL,
    "station_id" INTEGER NOT NULL,
    "theme" "display_theme" NOT NULL DEFAULT 'light',
    "compact" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "station_display_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "station_sync_config" (
    "id" SERIAL NOT NULL,
    "station_id" INTEGER NOT NULL,
    "interval_minutes" INTEGER NOT NULL,

    CONSTRAINT "station_sync_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_embedding_idx" ON "document"("embedding");

-- CreateIndex
CREATE UNIQUE INDEX "daily_peak_station_id_day_metric_key" ON "daily_peak"("station_id", "day", "metric");

-- CreateIndex
CREATE UNIQUE INDEX "station_alert_config_station_id_key" ON "station_alert_config"("station_id");

-- CreateIndex
CREATE UNIQUE INDEX "station_display_config_station_id_key" ON "station_display_config"("station_id");

-- CreateIndex
CREATE UNIQUE INDEX "station_sync_config_station_id_key" ON "station_sync_config"("station_id");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_peak" ADD CONSTRAINT "daily_peak_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reading" ADD CONSTRAINT "reading_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "region" ADD CONSTRAINT "region_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station" ADD CONSTRAINT "station_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_alert_config" ADD CONSTRAINT "station_alert_config_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_display_config" ADD CONSTRAINT "station_display_config_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_sync_config" ADD CONSTRAINT "station_sync_config_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
