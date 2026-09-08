-- NOTE: extensions (vector, pg_trgm, unaccent, azure_ai) are provisioned as infra (T01), not here —
-- CREATE EXTENSION for untrusted extensions fails as clic_app, so keep it out of migrations.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ClicPage" (
    "id" SERIAL NOT NULL,
    "nid" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contextualInformation" TEXT NOT NULL,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClicPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegislationSection" (
    "id" SERIAL NOT NULL,
    "path" TEXT NOT NULL,
    "capNumber" TEXT NOT NULL,
    "sectionHeading" TEXT,
    "sectionNumber" TEXT NOT NULL,
    "subsectionNumber" TEXT,
    "content" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "eLegislationUrl" TEXT,

    CONSTRAINT "LegislationSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegislationCap" (
    "id" SERIAL NOT NULL,
    "capNumber" TEXT NOT NULL,
    "title" TEXT,
    "longTitle" TEXT,
    "languageCode" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "eLegislationUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegislationCap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interpretation" (
    "id" SERIAL NOT NULL,
    "term" TEXT NOT NULL,
    "termDefinition" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "capNumber" TEXT NOT NULL,

    CONSTRAINT "Interpretation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Judgment" (
    "id" INTEGER NOT NULL,
    "neutralCitation" TEXT NOT NULL,
    "courtName" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "languageCode" TEXT NOT NULL,
    "isTranslation" BOOLEAN NOT NULL,
    "coram" TEXT,
    "parties" TEXT,
    "representations" TEXT,
    "charges" TEXT,
    "remarks" TEXT,
    "summary" TEXT,
    "summarySource" TEXT,
    "legalrefUrl" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "citationIndex" INTEGER,
    "inTextbook" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Judgment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParallelCitations" (
    "id" INTEGER NOT NULL,
    "citation" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "judgmentId" INTEGER NOT NULL,

    CONSTRAINT "ParallelCitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" INTEGER NOT NULL,
    "caseAct" TEXT NOT NULL,
    "actType" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "cjrId" INTEGER NOT NULL,
    "cjrDis" INTEGER NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clic_chunks" (
    "id" BIGSERIAL NOT NULL,
    "nid" INTEGER NOT NULL,
    "chunk_no" INTEGER NOT NULL,
    "language_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "context" TEXT,
    "embedding" vector(3072),
    "tsv" tsvector,
    "cjk_tokens" TEXT,

    CONSTRAINT "clic_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "judgment_chunks" (
    "id" BIGSERIAL NOT NULL,
    "judgment_id" INTEGER NOT NULL,
    "chunk_no" INTEGER NOT NULL,
    "language_code" TEXT NOT NULL,
    "neutral_citation" TEXT,
    "court_name" TEXT,
    "year" INTEGER,
    "date" TIMESTAMP(3),
    "parties" TEXT,
    "content" TEXT NOT NULL,
    "summary_source" TEXT,
    "url" TEXT,
    "embedding" vector(3072),
    "tsv" tsvector,
    "cjk_tokens" TEXT,

    CONSTRAINT "judgment_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ClicPageRelationToClicPage" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ClicPageRelationToClicPage_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ClicPageToLegislationSection" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ClicPageToLegislationSection_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ClicPageToLegislationCap" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ClicPageToLegislationCap_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ClicPageToJudgment" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ClicPageToJudgment_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LegislationSectionToLegislationSection" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_LegislationSectionToLegislationSection_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LegislationSectionToLegislationCap" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_LegislationSectionToLegislationCap_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_InterpretationToLegislationSection" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_InterpretationToLegislationSection_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_JudgmentToLegislationSection" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_JudgmentToLegislationSection_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_JudgmentToLegislationCap" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_JudgmentToLegislationCap_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_JudgmentToJudgment" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_JudgmentToJudgment_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_CaseToJudgment" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_CaseToJudgment_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "ClicPage_nid_languageCode_idx" ON "ClicPage"("nid", "languageCode");

-- CreateIndex
CREATE UNIQUE INDEX "ClicPage_nid_languageCode_key" ON "ClicPage"("nid", "languageCode");

-- CreateIndex
CREATE INDEX "LegislationSection_capNumber_sectionNumber_subsectionNumber_idx" ON "LegislationSection"("capNumber", "sectionNumber", "subsectionNumber", "languageCode");

-- CreateIndex
CREATE UNIQUE INDEX "LegislationSection_id_languageCode_key" ON "LegislationSection"("id", "languageCode");

-- CreateIndex
CREATE INDEX "LegislationCap_capNumber_languageCode_idx" ON "LegislationCap"("capNumber", "languageCode");

-- CreateIndex
CREATE UNIQUE INDEX "LegislationCap_capNumber_languageCode_key" ON "LegislationCap"("capNumber", "languageCode");

-- CreateIndex
CREATE INDEX "Interpretation_capNumber_term_languageCode_idx" ON "Interpretation"("capNumber", "term", "languageCode");

-- CreateIndex
CREATE UNIQUE INDEX "Case_caseAct_key" ON "Case"("caseAct");

-- CreateIndex
CREATE INDEX "clic_chunks_nid_language_code_idx" ON "clic_chunks"("nid", "language_code");

-- CreateIndex
CREATE UNIQUE INDEX "clic_chunks_nid_language_code_chunk_no_key" ON "clic_chunks"("nid", "language_code", "chunk_no");

-- CreateIndex
CREATE INDEX "judgment_chunks_judgment_id_idx" ON "judgment_chunks"("judgment_id");

-- CreateIndex
CREATE UNIQUE INDEX "judgment_chunks_judgment_id_chunk_no_key" ON "judgment_chunks"("judgment_id", "chunk_no");

-- CreateIndex
CREATE INDEX "_ClicPageRelationToClicPage_B_index" ON "_ClicPageRelationToClicPage"("B");

-- CreateIndex
CREATE INDEX "_ClicPageToLegislationSection_B_index" ON "_ClicPageToLegislationSection"("B");

-- CreateIndex
CREATE INDEX "_ClicPageToLegislationCap_B_index" ON "_ClicPageToLegislationCap"("B");

-- CreateIndex
CREATE INDEX "_ClicPageToJudgment_B_index" ON "_ClicPageToJudgment"("B");

-- CreateIndex
CREATE INDEX "_LegislationSectionToLegislationSection_B_index" ON "_LegislationSectionToLegislationSection"("B");

-- CreateIndex
CREATE INDEX "_LegislationSectionToLegislationCap_B_index" ON "_LegislationSectionToLegislationCap"("B");

-- CreateIndex
CREATE INDEX "_InterpretationToLegislationSection_B_index" ON "_InterpretationToLegislationSection"("B");

-- CreateIndex
CREATE INDEX "_JudgmentToLegislationSection_B_index" ON "_JudgmentToLegislationSection"("B");

-- CreateIndex
CREATE INDEX "_JudgmentToLegislationCap_B_index" ON "_JudgmentToLegislationCap"("B");

-- CreateIndex
CREATE INDEX "_JudgmentToJudgment_B_index" ON "_JudgmentToJudgment"("B");

-- CreateIndex
CREATE INDEX "_CaseToJudgment_B_index" ON "_CaseToJudgment"("B");

-- AddForeignKey
ALTER TABLE "LegislationSection" ADD CONSTRAINT "LegislationSection_capNumber_languageCode_fkey" FOREIGN KEY ("capNumber", "languageCode") REFERENCES "LegislationCap"("capNumber", "languageCode") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Interpretation" ADD CONSTRAINT "Interpretation_capNumber_languageCode_fkey" FOREIGN KEY ("capNumber", "languageCode") REFERENCES "LegislationCap"("capNumber", "languageCode") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ParallelCitations" ADD CONSTRAINT "ParallelCitations_judgmentId_fkey" FOREIGN KEY ("judgmentId") REFERENCES "Judgment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clic_chunks" ADD CONSTRAINT "clic_chunks_nid_language_code_fkey" FOREIGN KEY ("nid", "language_code") REFERENCES "ClicPage"("nid", "languageCode") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "judgment_chunks" ADD CONSTRAINT "judgment_chunks_judgment_id_fkey" FOREIGN KEY ("judgment_id") REFERENCES "Judgment"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "_ClicPageRelationToClicPage" ADD CONSTRAINT "_ClicPageRelationToClicPage_A_fkey" FOREIGN KEY ("A") REFERENCES "ClicPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClicPageRelationToClicPage" ADD CONSTRAINT "_ClicPageRelationToClicPage_B_fkey" FOREIGN KEY ("B") REFERENCES "ClicPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClicPageToLegislationSection" ADD CONSTRAINT "_ClicPageToLegislationSection_A_fkey" FOREIGN KEY ("A") REFERENCES "ClicPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClicPageToLegislationSection" ADD CONSTRAINT "_ClicPageToLegislationSection_B_fkey" FOREIGN KEY ("B") REFERENCES "LegislationSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClicPageToLegislationCap" ADD CONSTRAINT "_ClicPageToLegislationCap_A_fkey" FOREIGN KEY ("A") REFERENCES "ClicPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClicPageToLegislationCap" ADD CONSTRAINT "_ClicPageToLegislationCap_B_fkey" FOREIGN KEY ("B") REFERENCES "LegislationCap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClicPageToJudgment" ADD CONSTRAINT "_ClicPageToJudgment_A_fkey" FOREIGN KEY ("A") REFERENCES "ClicPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClicPageToJudgment" ADD CONSTRAINT "_ClicPageToJudgment_B_fkey" FOREIGN KEY ("B") REFERENCES "Judgment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LegislationSectionToLegislationSection" ADD CONSTRAINT "_LegislationSectionToLegislationSection_A_fkey" FOREIGN KEY ("A") REFERENCES "LegislationSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LegislationSectionToLegislationSection" ADD CONSTRAINT "_LegislationSectionToLegislationSection_B_fkey" FOREIGN KEY ("B") REFERENCES "LegislationSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LegislationSectionToLegislationCap" ADD CONSTRAINT "_LegislationSectionToLegislationCap_A_fkey" FOREIGN KEY ("A") REFERENCES "LegislationCap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LegislationSectionToLegislationCap" ADD CONSTRAINT "_LegislationSectionToLegislationCap_B_fkey" FOREIGN KEY ("B") REFERENCES "LegislationSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_InterpretationToLegislationSection" ADD CONSTRAINT "_InterpretationToLegislationSection_A_fkey" FOREIGN KEY ("A") REFERENCES "Interpretation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_InterpretationToLegislationSection" ADD CONSTRAINT "_InterpretationToLegislationSection_B_fkey" FOREIGN KEY ("B") REFERENCES "LegislationSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JudgmentToLegislationSection" ADD CONSTRAINT "_JudgmentToLegislationSection_A_fkey" FOREIGN KEY ("A") REFERENCES "Judgment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JudgmentToLegislationSection" ADD CONSTRAINT "_JudgmentToLegislationSection_B_fkey" FOREIGN KEY ("B") REFERENCES "LegislationSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JudgmentToLegislationCap" ADD CONSTRAINT "_JudgmentToLegislationCap_A_fkey" FOREIGN KEY ("A") REFERENCES "Judgment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JudgmentToLegislationCap" ADD CONSTRAINT "_JudgmentToLegislationCap_B_fkey" FOREIGN KEY ("B") REFERENCES "LegislationCap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JudgmentToJudgment" ADD CONSTRAINT "_JudgmentToJudgment_A_fkey" FOREIGN KEY ("A") REFERENCES "Judgment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JudgmentToJudgment" ADD CONSTRAINT "_JudgmentToJudgment_B_fkey" FOREIGN KEY ("B") REFERENCES "Judgment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CaseToJudgment" ADD CONSTRAINT "_CaseToJudgment_A_fkey" FOREIGN KEY ("A") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CaseToJudgment" ADD CONSTRAINT "_CaseToJudgment_B_fkey" FOREIGN KEY ("B") REFERENCES "Judgment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

