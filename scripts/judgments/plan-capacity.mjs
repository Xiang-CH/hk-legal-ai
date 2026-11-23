#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
const {values:options}=parseArgs({options:{estimate:{type:'string'},sample:{type:'string'},price:{type:'string'},database:{type:'string'},azure:{type:'string'},output:{type:'string'}}});
if(Object.values(options).length!==6)throw Error('--estimate --sample --price --database --azure --output are required');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const estimate=read(options.estimate),sample=read(options.sample),price=read(options.price),database=read(options.database),azure=read(options.azure);
if(estimate.complete!==true||estimate.files!==152656||estimate.valid+estimate.rejected!==estimate.files||estimate.providerCalls!==0)throw Error('Complete reconciled 152656-file content estimate required; partial results cannot set the full-run budget');
if(!Number.isSafeInteger(estimate.billableTokens)||estimate.billableTokens<1||!Number.isSafeInteger(estimate.chunks)||estimate.chunks<1)throw Error('Invalid corpus totals');
if(sample.vectors!==sample.chunks||!Number.isFinite(sample.bytesPerChunk)||sample.bytesPerChunk<=0)throw Error('Fully embedded storage sample required');
if(!Number.isFinite(price.retailCeilingUsdPerMillion)||price.retailCeilingUsdPerMillion<=0||!Number.isFinite(database.databaseBytes)||!Number.isFinite(azure.storageSizeGb))throw Error('Explicit price and capacity evidence required');
const chunkBytes=Math.ceil(estimate.chunks*sample.bytesPerChunk);
const allocationBytes=azure.storageSizeGb*1024**3;
const report={createdAt:new Date().toISOString(),parserVersion:estimate.parserVersion,files:estimate.files,valid:estimate.valid,rejected:estimate.rejected,chunks:estimate.chunks,billableTokens:estimate.billableTokens,
 estimatedEmbeddingUsd:estimate.billableTokens*price.retailCeilingUsdPerMillion/1000000,
 priceSource:price.priceSource,priceSnapshotAt:price.completedAt,
 proposedEmbeddingLimitUsd:Math.ceil(estimate.billableTokens*price.retailCeilingUsdPerMillion/1000000*1.25),
 budgetMargin:0.25,approvalGranted:false,
 storage:{sampleBasedChunkBytes:chunkBytes,currentDatabaseBytes:database.databaseBytes,allocationBytes,chunkPlusBaseBytes:chunkBytes+database.databaseBytes,
 exceedsAllocationBeforeOtherData:chunkBytes+database.databaseBytes>allocationBytes,
 sampleIsRepresentative:false,excludes:sample.excludes,capacityApprovalReady:false},
 nextSteps:['Refresh provider pricing before requesting full-run approval','Measure documents, paragraphs, references, WAL and index-build headroom','Obtain approval before increasing Azure capacity or invoking full paid embeddings'],providerCalls:0};
fs.writeFileSync(options.output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
