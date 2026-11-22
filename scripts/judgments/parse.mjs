import { parse, serializeOuter, serialize } from 'parse5';

export const PARSER_VERSION = 'structural-7';
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

function splitAtMarkers(node) {
  if (excluded.has(node.tagName) || markerLabel(node) || !children(node).length) {
    return [{startsParagraph:Boolean(markerLabel(node)), node}];
  }
  const groups = [];
  for (const child of children(node)) {
    for (const part of splitAtMarkers(child)) {
      if (!groups.length || part.startsParagraph) groups.push({startsParagraph:part.startsParagraph, children:[]});
      groups.at(-1).children.push(part.node);
    }
  }
  return groups.map((group,index) => ({
    startsParagraph:group.startsParagraph,
    node:{...node, childNodes:group.children, attrs:index ? node.attrs?.filter(attr => attr.name !== 'id' && attr.name !== 'name') : node.attrs},
  }));
}

/** Convert judgment HTML into ordered content blocks with source anchors and printed paragraph labels; keep unnumbered text and tables. */
export function parseJudgment(html) {
  if(typeof html!=='string'||!html.trim())throw Error('Empty HTML');
  const root=parse(html);
  const blocks=[];
  let continuation=false;
  let pendingMarker;
  function append(node,blockType,retainedHtml) {
    const content=clean(nodeText(node));
    const marker=blockType==='paragraph'?[node,...descendants(node)].find(markerLabel):null;
    if (!content) {
      if (marker) pendingMarker={label:markerLabel(marker),anchor:findAnchor(marker),html:retainedHtml};
      return;
    }
    const carried = !marker && (blockType==='paragraph' || blockType==='text') ? pendingMarker : undefined;
    pendingMarker=undefined;
    if (carried) {
      blockType='paragraph';
      retainedHtml=carried.html+'\n'+retainedHtml;
    }
    const anchor=(marker && findAnchor(marker)) || carried?.anchor || findAnchor(node);
    const label=marker ? markerLabel(marker) : carried?.label ?? null;
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
      const marked=descendants(fragment).some(child=>markerLabel(child));
      for (const part of marked ? splitAtMarkers(fragment) : [{node:fragment}]) {
        append(part.node,marked?'paragraph':'text',serialize(part.node));
      }
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
      const parts = blockType === 'paragraph' && descendants(node).some(markerLabel) ? splitAtMarkers(node) : [{node}];
      for (const part of parts) append(part.node,blockType,serializeOuter(part.node));
      return;
    }
    visitContainer(node);
  }
  const body=children(root).find(node=>node.tagName==='html')?.childNodes.find(node=>node.tagName==='body');
  visit(body ?? root);
  if(!blocks.length)throw Error('No readable judgment content');
  return {plainText:blocks.map(block=>block.content).join('\n\n'),blocks,references:[]};
}
