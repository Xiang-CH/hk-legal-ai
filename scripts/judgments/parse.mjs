import { parse, serializeOuter, serialize } from 'parse5';

export const PARSER_VERSION = 'structural-5';
const excluded = new Set(['head','script','style','nav','button','input','select','textarea','noscript','template']);
const boundaries = new Set(['p','div','section','article','main','li','ul','ol','table','thead','tbody','tfoot','tr','td','th','h1','h2','h3','h4','h5','h6','pre','blockquote']);
const leafBlocks = new Set(['p','table','li','h1','h2','h3','h4','h5','h6','pre','blockquote']);
const attribute = (node,name) => node.attrs?.find(entry=>entry.name===name)?.value;
const children = node => node.childNodes ?? [];
const descendants = node => children(node).flatMap(child=>[child,...descendants(child)]);
/** Recognize a structural paragraph marker without treating arbitrary inline numbers as paragraph labels. */
const markerLabel = node => {
  if(node.tagName!=='a')return null;
  const anchor=attribute(node,'id') || attribute(node,'name') || '';
  const numberedAnchor=anchor.match(/^p(\d+[A-Za-z]?)$/i)?.[1];
  if(numberedAnchor)return numberedAnchor;
  if(!/(?:^|\s)para(?:\s|$)/i.test(attribute(node,'class') || ''))return null;
  return nodeText(node).trim().match(/^(?:\[(\d+[A-Za-z]?)\]|(\d+[A-Za-z]?)[.)]?)$/)?.slice(1).find(Boolean) ?? null;
};
/** Collect visible node text while preserving line breaks and excluding scripts, styles and navigation. */
function nodeText(node) {
  if(excluded.has(node.tagName))return '';
  if(node.nodeName==='#text')return node.value;
  if(node.tagName==='br')return '\n';
  const content=children(node).map(nodeText).join('');
  if(node.tagName==='td'||node.tagName==='th')return content+'\t';
  return content+(boundaries.has(node.tagName)?'\n':'');
}
const clean = value => value.replace(/\s+/g,' ').trim();
const findAnchor = node => attribute(node,'id') || attribute(node,'name') || children(node).map(findAnchor).find(Boolean) || null;

/** Convert judgment HTML into ordered content blocks with source anchors and printed paragraph labels; keep unnumbered text and tables. */
export function parseJudgment(html) {
  if(typeof html!=='string'||!html.trim())throw Error('Empty HTML');
  const root=parse(html);
  const blocks=[];
  let continuation=false;
  function append(node,blockType,retainedHtml) {
    const content=clean(nodeText(node));
    if(!content)return;
    const anchor=findAnchor(node);
    const markers=[node,...descendants(node)].map(markerLabel).filter(Boolean);
    const label=blockType==='paragraph'?markers[0] ?? null:null;
    const ordinal=/^\d+[A-Za-z]?[.)](?:\s|$)/.test(content);
    const previous=blocks.at(-1);
    if(blockType==='paragraph'&&!label&&!anchor&&!ordinal&&continuation&&previous?.blockType==='paragraph') {
      previous.content+='\n'+content;
      previous.html+='\n'+retainedHtml;
    } else {
      blocks.push({position:blocks.length,label,anchor,blockType,content,html:retainedHtml});
      continuation=blockType==='paragraph'&&Boolean(label);
    }
  }
  function visitContainer(node) {
    let inline=[];
    const flush=()=>{
      if(!inline.length)return;
      const fragment={nodeName:'#document-fragment',childNodes:inline};
      const marked=inline.some(child=>markerLabel(child));
      append(fragment,marked?'paragraph':'text',serialize(fragment));
      inline=[];
    };
    for(const child of children(node)) {
      if(excluded.has(child.tagName))continue;
      if(markerLabel(child))flush();
      if(boundaries.has(child.tagName)||descendants(child).some(entry=>boundaries.has(entry.tagName))) {
        flush();visit(child);
      } else inline.push(child);
    }
    flush();
  }
  function visit(node) {
    if(excluded.has(node.tagName))return;
    if(node.tagName==='table') {
      const nested=descendants(node);
      const layout=nested.some(entry=>entry.tagName==='table'||markerLabel(entry)) || nested.filter(entry=>entry.tagName==='td'||entry.tagName==='th').length===1;
      if(layout){visitContainer(node);return;}
    }
    if(leafBlocks.has(node.tagName)) {
      const anchor=findAnchor(node);
      const blockType=node.tagName==='table'?'table':/^h[1-6]$/.test(node.tagName)||/heading/i.test(attribute(node,'class')||'')?'heading':node.tagName==='li'?'list':node.tagName==='blockquote'?'quotation':/footnote/i.test((attribute(node,'class')||'')+(anchor||''))?'footnote':'paragraph';
      append(node,blockType,serializeOuter(node));
      return;
    }
    visitContainer(node);
  }
  const body=children(root).find(node=>node.tagName==='html')?.childNodes.find(node=>node.tagName==='body');
  visit(body ?? root);
  if(!blocks.length)throw Error('No readable judgment content');
  return {plainText:blocks.map(block=>block.content).join('\n\n'),blocks,references:[]};
}
