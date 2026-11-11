-- CreateEnum
CREATE TYPE "book_status" AS ENUM ('wanted', 'reading', 'finished');

-- CreateTable
CREATE TABLE "reader" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book" (
    "id" TEXT NOT NULL,
    "reader_id" TEXT,
    "title" TEXT NOT NULL,
    "pages" INTEGER,
    "status" "book_status" NOT NULL DEFAULT 'wanted',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "book_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "book_reader_id_title_key" ON "book"("reader_id", "title");

-- AddForeignKey
ALTER TABLE "book" ADD CONSTRAINT "book_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "reader"("id") ON DELETE SET NULL ON UPDATE CASCADE;
