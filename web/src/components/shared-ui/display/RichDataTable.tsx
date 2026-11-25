import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import type { RichCellObject, RichPrimitive, RichDisplayNode } from '../../../../../shared/rich-schema';
import { text } from '../runtime';
type Node = Extract<RichDisplayNode,{type:'data_table'}>;
type Row=Record<string,RichPrimitive|RichCellObject>;
function cellValue(c:RichPrimitive|RichCellObject|undefined):RichPrimitive|undefined{
  return c!==null&&typeof c==='object' ? c.value : c;
}
function cellText(c:RichPrimitive|RichCellObject|undefined,column:Node['columns'][number]){
  const v=cellValue(c);
  if(v==null)return column.missingLabel??'—';
  if(typeof v==='number'&&Number.isFinite(v)){
    if(column.format==='percent')return new Intl.NumberFormat(undefined,{style:'percent',maximumFractionDigits:2}).format(v);
    if(column.format==='currency'){
      try{return new Intl.NumberFormat(undefined,{style:'currency',currency:column.unit??'JPY'}).format(v)}catch{}
    }
    if(column.format==='number')return new Intl.NumberFormat().format(v)+(column.unit??'');
  }
  return text(v)+(column.unit&&column.format!=='currency'?column.unit:'');
}
export function RichDataTable({node,rows,onSelect}:{node:Node;rows:Row[];onSelect?:(row:Row,index:number)=>void}){
  const [search,setSearch]=useState('');
  const [sort,setSort]=useState<{key:string;desc:boolean}|null>(null);
  const [page,setPage]=useState(0);
  const pageSize=Math.max(1,Math.min(200,Math.floor(node.pageSize??50)));
  const ordered=useMemo(()=>{
    const query=search.trim().toLocaleLowerCase();
    const entries=rows.map((row,index)=>({row,index})).filter(({row})=>!query||node.columns.some(c=>cellText(row[c.key],c).toLocaleLowerCase().includes(query)));
    if(sort)entries.sort((a,b)=>{
      const av=cellValue(a.row[sort.key]),bv=cellValue(b.row[sort.key]);
      if(av==null||bv==null)return av==null?(bv==null?0:1):-1;
      const result=typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv),undefined,{numeric:true});
      return sort.desc?-result:result;
    });
    return entries;
  },[rows,search,sort,node.columns]);
  const pageCount=Math.max(1,Math.ceil(ordered.length/pageSize));
  const current=Math.min(page,pageCount-1);
  const visibleRows=useMemo(()=>ordered.slice(current*pageSize,(current+1)*pageSize),[ordered,current,pageSize]);
  const scroll=useRef<HTMLDivElement>(null),header=useRef<HTMLTableSectionElement>(null);
  const [headerHeight,setHeaderHeight]=useState(36);
  const virtual=visibleRows.length>30;
  const rowVirtualizer=useVirtualizer({
    count:visibleRows.length,enabled:virtual,getScrollElement:()=>scroll.current,
    estimateSize:()=>48,overscan:6,scrollMargin:headerHeight,
    getItemKey:index=>visibleRows[index]?.index??index,
  });
  useLayoutEffect(()=>{
    const el=header.current;if(!el)return;
    const measure=()=>setHeaderHeight(el.offsetHeight);
    measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{if(scroll.current)scroll.current.scrollTop=0},[search,sort,current]);
  const items=virtual?rowVirtualizer.getVirtualItems():[];
  const top=items.length?Math.max(0,items[0].start-headerHeight):0;
  const bottom=items.length?Math.max(0,rowVirtualizer.getTotalSize()-(items.at(-1)!.end-headerHeight)):0;
  const renderRows=virtual?items.map(item=>({entry:visibleRows[item.index],position:item.index})):visibleRows.map((entry,position)=>({entry,position}));
  return <div className="rich-data-table">
    {node.searchable&&<label className="field">検索<input type="search" value={search} onChange={e=>{setSearch(e.target.value);setPage(0)}}/></label>}
    <div className="rich-table-scroll" ref={scroll} tabIndex={0} aria-label="表のスクロール領域"><table className={virtual?'rich-virtual-table':undefined} aria-rowcount={visibleRows.length+1} style={virtual?{tableLayout:'fixed',minWidth:node.columns.length*125}:undefined}><thead ref={header}><tr>{node.columns.map(c=><th key={c.key} scope="col" style={{textAlign:c.align}} aria-sort={sort?.key===c.key?(sort.desc?'descending':'ascending'):undefined}>
      {node.sortable||c.sortable?<button type="button" className="btn btn-ghost btn-xs" onClick={()=>{setSort(s=>({key:c.key,desc:s?.key===c.key&&!s.desc}));setPage(0)}}>{c.label}{sort?.key===c.key?(sort.desc?' ↓':' ↑'):''}</button>:c.label}
    </th>)}</tr></thead><tbody>
    {virtual&&top>0&&<tr aria-hidden="true"><td colSpan={node.columns.length} className="rich-table-spacer" style={{height:top}}/></tr>}
    {renderRows.map(({entry:{row,index},position})=><tr key={index} data-index={position} aria-rowindex={position+2} ref={virtual?rowVirtualizer.measureElement:undefined}
      {...(onSelect?{onClick:()=>onSelect(row,index),tabIndex:0,onKeyDown:(e:React.KeyboardEvent)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(row,index)}}}:{})}>
      {node.columns.map(c=>{
        const cell=row[c.key];const meta=cell!==null&&typeof cell==='object'?cell:undefined;
        return <td key={c.key} style={{textAlign:c.align}}><span>{cellText(cell,c)}</span>{meta&&<small className="rich-cell-meta">{[meta.missingReason,meta.sourceId,meta.asOf,meta.fetchedAt].filter(Boolean).join(' · ')}</small>}</td>;
      })}
    </tr>)}
    {virtual&&bottom>0&&<tr aria-hidden="true"><td colSpan={node.columns.length} className="rich-table-spacer" style={{height:bottom}}/></tr>}
    </tbody></table>{!ordered.length&&<p className="muted-sm">該当するデータがありません。</p>}</div>
    {pageCount>1&&<div className="rich-table-page"><button type="button" className="btn btn-secondary btn-xs" disabled={current===0} onClick={()=>setPage(current-1)}>前へ</button><span>{current+1} / {pageCount}</span><button type="button" className="btn btn-secondary btn-xs" disabled={current+1===pageCount} onClick={()=>setPage(current+1)}>次へ</button></div>}
  </div>;
}
