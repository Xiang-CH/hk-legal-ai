#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parseJudgment,PARSER_VERSION } from './parse.mjs';

const words=parseJudgment('<p>trade<span>mark</span> and non-<b>disclosure</b>, not fiction.</p>');
assert.equal(words.plainText,'trademark and non-disclosure, not fiction.');
const boundaries=parseJudgment('<body><a class="para" id="p1">1.</a> First paragraph.<br><a class="para" id="p2">2.</a> Second paragraph.</body>');
assert.equal(boundaries.blocks.length,2);
assert.deepEqual(boundaries.blocks.map(block=>block.label),['1','2']);
const structured=parseJudgment('<script>excluded control</script><h2>1. Heading</h2><p>[2020] HKCA 2</p><li>1. List entry</li><p><a id="p22">22.</a> Official paragraph.</p><p>Continuation belongs here.</p><blockquote>[1] Quoted numbering is not this judgment numbering.</blockquote><table><tr><td>Item</td><td>Amount</td></tr><tr><td>Costs</td><td>100</td></tr></table><p class="footnote"><a id="fn1">1.</a> Footnote.</p>');
assert.equal(structured.blocks[0].label,null);
assert.equal(structured.blocks[1].label,null);
assert.equal(structured.blocks[2].label,null);
assert(structured.blocks.find(block=>block.anchor==='p22').content.includes('Continuation'));
assert.equal(structured.blocks.find(block=>block.blockType==='quotation').label,null);
assert(structured.blocks.find(block=>block.blockType==='table').html.includes('<td>Amount</td>'));
assert.equal(structured.blocks.find(block=>block.blockType==='footnote').label,null);
assert(!structured.plainText.includes('excluded control'));
console.log(JSON.stringify({parserVersion:PARSER_VERSION,inlineWords:true,markerBoundaries:true,sourceLabelsOnly:true,continuations:true,quotation:true,table:true,footnote:true,providerCalls:0}));
