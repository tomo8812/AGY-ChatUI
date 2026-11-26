import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {previewFormulas,type FormulaCell} from '../formulaPreview';
import { workspaceApi,supportsOperation } from '../../../api/workspace';
import {ResponsiveCommandBar} from '../../shared-ui/layout/ResponsiveCommandBar';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import {artifactVersionKey,ByteLruCache} from '../../../utils/viewerCache';
import type { WorkspaceModuleProps } from '../types';

type Sheet={id:string;name:string;part:string};
type Cell={address:string;value:unknown;type?:string;formula?:string;formulaStatus?:string;bold?:boolean};
type Coordinate={row:number;col:number};
const FORMULA_STATUS:Record<string,string>={
  evaluated_lo:'再計算済み',
  cached_existing:'ファイルに保存された計算結果',
  unevaluated_unsupported:'数式の計算結果を取得できませんでした',
  error_formula:'数式エラー',
};
type GridTile={cells:Map<string,Cell>;rows?:string[][];sourceRows?:number[]};
type CsvRange={rows:string[][];truncated?:boolean;sourceRows?:number[];truncatedSourceRow?:number};
const ROWS=50,COLS=20,CELL_WIDTH=112,CELL_HEIGHT=28,HEADER=44;
// Native scroll ranges have engine-specific limits. Compress only the scroll
// track of very large axes; the visible cells retain their actual pixel size.
const NATIVE_SCROLL_LIMIT=16_000_000;
function axis(count:number,cell:number,header:number,viewport:number,offset:number){
  const logicalSize=header+count*cell,plane=Math.min(NATIVE_SCROLL_LIMIT,logicalSize);
  const physicalMax=Math.max(0,plane-viewport),logicalMax=Math.max(0,logicalSize-viewport);
  const logicalOffset=physicalMax?Math.max(0,Math.min(logicalMax,offset*logicalMax/physicalMax)):0;
  const start=Math.max(0,Math.min(count-1,Math.floor(logicalOffset/cell))-8);
  const length=Math.min(count-start,Math.ceil(viewport/cell)+18);
  return {plane,start,length,logicalOffset,logicalMax,physicalMax,margin:header+start*cell+offset-logicalOffset,viewport,header,cell};
}
function reveal(a:ReturnType<typeof axis>,index:number){
  const left=index*a.cell,right=left+a.cell;
  const visible=Math.max(a.cell,a.viewport-a.header);
  const wanted=left<a.logicalOffset?left:right>a.logicalOffset+visible?right-visible:a.logicalOffset;
  return a.logicalMax?Math.max(0,Math.min(a.logicalMax,wanted))*a.physicalMax/a.logicalMax:0;
}
function colName(n:number){let s='';for(n++;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s}
function address(row:number,col:number){return colName(col)+(row+1)}
function parseAddress(value:string):Coordinate|null{
  const match=/^([A-Z]+)([1-9]\d*)$/i.exec(value.trim());
  if(!match)return null;
  const row=Number(match[2])-1,col=[...match[1].toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
  return Number.isSafeInteger(row)&&Number.isSafeInteger(col)?{row,col}:null;
}
function tileKey(r:number,c:number){return Math.floor(r/ROWS)+':'+Math.floor(c/COLS)}
function tileBounds(key:string,rowCount:number,colCount:number){
  const [r,c]=key.split(':').map(Number),row0=r*ROWS,col0=c*COLS;
  return {row0,col0,row1:Math.min(rowCount-1,row0+ROWS-1),col1:Math.min(colCount-1,col0+COLS-1)};
}
async function csvTile(artifact:WorkspaceModuleProps['artifact'],r0:number,r1:number,c0:number,c1:number,signal:AbortSignal,filter:string):Promise<CsvRange>{
  const result=await workspaceApi.range<CsvRange>(artifact.id,{startRow:r0,endRow:r1,startCol:c0,endCol:c1,...(filter?{gridFilter:filter}:{})},signal);
  assertRevision(artifact,result);
  if(!result.truncated)return result;
  if(r0<r1){
    const middle=Math.floor((r0+r1)/2),left=await csvTile(artifact,r0,middle,c0,c1,signal,filter),right=await csvTile(artifact,middle+1,r1,c0,c1,signal,filter);
    return {rows:[...left.rows,...right.rows],sourceRows:filter?[...(left.sourceRows??[]),...(right.sourceRows??[])]:undefined};
  }
  if(c0<c1){
    const middle=Math.floor((c0+c1)/2),left=await csvTile(artifact,r0,r1,c0,middle,signal,filter),right=await csvTile(artifact,r0,r1,middle+1,c1,signal,filter);
    return {sourceRows:left.sourceRows,rows:left.rows.map((row,i)=>[...row,...(right.rows[i]?.length?Array(Math.max(0,middle-c0+1-row.length)).fill(''):[]),...(right.rows[i]??[])])};
  }
  const sourceRow=result.truncatedSourceRow??r0;
  return {rows:[[await workspaceApi.csvCell(artifact,sourceRow,c0,signal)]],sourceRows:filter?[sourceRow]:undefined};
}
export function GridModule(props:WorkspaceModuleProps){
  const {artifact,mode,draft,capabilities,editingLocked,onDraft,onTarget}=props;
  const xlsx=/\.xlsx$/i.test(artifact.filename);
  const [sheetId,setSheetId]=useState('');
  const [selected,setSelected]=useState<Coordinate>({row:0,col:0});
  const [anchor,setAnchor]=useState<Coordinate>({row:0,col:0});
  const [jump,setJump]=useState('');
  const [pinError,setPinError]=useState('');
  const [editAction,setEditAction]=useState('');
  const [sheetName,setSheetName]=useState('');
  const structureSequence=useRef(0);
  const [filterInput,setFilterInput]=useState('');
  const [appliedFilter,setAppliedFilter]=useState('');
  const filter=xlsx||mode==='pin'?'':appliedFilter;
  const [search,setSearch]=useState('');
  const [searching,setSearching]=useState(false);
  const searchAbort=useRef<AbortController|null>(null);
  const formulaInput=useRef<HTMLInputElement>(null);
  const scroll=useRef<HTMLDivElement>(null);
  const pendingReveal=useRef<Coordinate|null>(null);
  const [viewport,setViewport]=useState({top:0,left:0,width:800,height:420});
  const structure=useRevisionResource<{sheets:Sheet[];rowCount?:number;colCount?:number}>(artifact,'grid-structure:'+filter,async signal=>{
    if(xlsx){
      const result=await workspaceApi.structure<{sheets:Sheet[]}>(artifact.id,signal);assertRevision(artifact,result);return result;
    }
    const result=await workspaceApi.range<{totalRows:number;totalCols:number}>(artifact.id,{gridDimensions:true,...(filter?{gridFilter:filter}:{})},signal);
    assertRevision(artifact,result);
    if(!Number.isSafeInteger(result.totalRows)||result.totalRows<0||!Number.isSafeInteger(result.totalCols)||result.totalCols<0)throw Error('表のサイズを取得できません。');
    return {sheets:[{id:'csv',name:artifact.filename,part:''}],rowCount:result.totalRows,colCount:result.totalCols};
  });
  const sheets=structure.data?.sheets??[];
  const sheet=sheets.find(s=>s.id===sheetId)??sheets[0];
  const csvRows=structure.data?.rowCount??0,csvCols=structure.data?.colCount??0;
  const rowCount=xlsx?1048576:Math.max(1,csvRows),colCount=xlsx?16384:Math.max(1,csvCols);
  const csvEmpty=structure.ready&&!xlsx&&!filter&&csvRows===0;
  const updateViewport=()=>{const el=scroll.current;if(!el)return;const next={top:el.scrollTop,left:el.scrollLeft,width:el.clientWidth,height:el.clientHeight};setViewport(old=>old.top===next.top&&old.left===next.left&&old.width===next.width&&old.height===next.height?old:next)};
  useEffect(()=>{
    const el=scroll.current;if(!el)return;updateViewport();
    const observer=new ResizeObserver(updateViewport);observer.observe(el);
    return()=>observer.disconnect();
  },[!!sheet]);
  const rowAxis=axis(rowCount,CELL_HEIGHT,CELL_HEIGHT,viewport.height,viewport.top),colAxis=axis(colCount,CELL_WIDTH,HEADER,viewport.width,viewport.left);
  // Keep the rendered cell count proportional to the viewport.
  const items=(a:ReturnType<typeof axis>)=>Array.from({length:a.length},(_,index)=>({index,start:a.margin+index*a.cell,size:a.cell}));
  const rows=items(rowAxis),cols=items(colAxis);
  const current={row:Math.min(rowCount-1,selected.row),col:Math.min(colCount-1,selected.col)};
  useEffect(()=>{
    if(structure.ready&&(current.row!==selected.row||current.col!==selected.col)){setSelected(current);setAnchor(current)}
  },[structure.ready,rowCount,colCount]);
  const bounds={row0:Math.min(anchor.row,current.row),row1:Math.max(anchor.row,current.row),col0:Math.min(anchor.col,current.col),col1:Math.max(anchor.col,current.col)};
  const selectedRange=address(bounds.row0,bounds.col0)+(bounds.row0===bounds.row1&&bounds.col0===bounds.col1?'':':'+address(bounds.row1,bounds.col1));
  const visibleKeys:string[]=[];
  for(let r=Math.floor(rowAxis.start/ROWS);r<=Math.floor((rowAxis.start+rowAxis.length-1)/ROWS);r++)
    for(let c=Math.floor(colAxis.start/COLS);c<=Math.floor((colAxis.start+colAxis.length-1)/COLS);c++)visibleKeys.push(r+':'+c);
  const keys=[...new Set([tileKey(current.row,current.col),...visibleKeys])],keySignature=keys.join(',');
  const revisionKey=artifactVersionKey(artifact);
  const cache=useMemo(()=>new ByteLruCache<string,GridTile>({
    maxEntries:48,maxBytes:24*1024*1024,maxSingleEntryBytes:20*1024*1024,
    sizeOf:tile=>tile.rows
      ?tile.rows.reduce((bytes,row)=>bytes+40+row.reduce((size,value)=>size+16+value.length*2,0),0)
      :JSON.stringify([...tile.cells.values()]).length*2+tile.cells.size*96,
  }),[artifact.userId,revisionKey,sheet?.id,filter]);
  // Protect visible and selected tiles while other tiles compete for the LRU budget.
  const activeTiles=useMemo(()=>new Map<string,GridTile>(),[cache]);
  const readTile=(key:string)=>activeTiles.get(key)??cache.peek(key);
  const [cacheVersion,setCacheVersion]=useState(0),[retry,setRetry]=useState(0);
  const [rangeError,setRangeError]=useState('');
  useEffect(()=>{
    if(!sheet||!structure.ready)return;
    const controller=new AbortController();setRangeError('');
    for(const key of activeTiles.keys())if(!keys.includes(key))activeTiles.delete(key);
    void(async()=>{
      for(const key of keys){
        if(controller.signal.aborted)return;
        const existing=cache.get(key)??activeTiles.get(key);
        if(existing){activeTiles.set(key,existing);continue;}
        const b=tileBounds(key,rowCount,colCount);
        try{
          let tile:GridTile;
          if(xlsx){
            const result=await workspaceApi.range<{cells:Cell[]}>(artifact.id,{sheetId:sheet.id,rangeA1:address(b.row0,b.col0)+':'+address(b.row1,b.col1),evaluate:true},controller.signal);
            assertRevision(artifact,result);
            tile={cells:new Map(result.cells.map(cell=>[cell.address,cell]))};
          }else {
            const {rows,sourceRows}=await csvTile(artifact,b.row0,b.row1,b.col0,b.col1,controller.signal,filter);
            tile={cells:new Map(),rows,sourceRows};
          }
          if(controller.signal.aborted)return;
          cache.set(key,tile);
          activeTiles.set(key,tile);
          setCacheVersion(v=>v+1);
        }catch(e){if(!controller.signal.aborted)setRangeError(e instanceof Error?e.message:'表を読み込めません。')}
      }
    })();
    return()=>controller.abort();
  },[cache,keySignature,retry,structure.ready,rowCount,colCount]);
  const tile=(r:number,c:number)=>readTile(tileKey(r,c));
  const raw=(r:number,c:number)=>xlsx?tile(r,c)?.cells.get(address(r,c)):undefined;
  const sourceRow=(r:number,c:number)=>tile(r,c)?.sourceRows?.[r%ROWS]??r;
  const key=(r:number,c:number)=>String(sheet?.id)+':'+address(sourceRow(r,c),c);
  function original(r:number,c:number){const cell=raw(r,c);return xlsx?cell?.formula?'='+cell.formula.replace(/^=/,''):String(cell?.value??''):String(tile(r,c)?.rows?.[r%ROWS]?.[c%COLS]??'')}
  const ready=structure.ready&&!!sheet&&!!tile(current.row,current.col);
  const inData=xlsx||current.row<csvRows&&current.col<csvCols;
  const editableCoordinate=inData||csvEmpty&&current.row===0&&current.col===0;
  const loading=structure.loading||keys.some(key=>!readTile(key));
  const latest=useRef({revisionKey,sheetId:sheet?.id,selectedRange,filter});latest.current={revisionKey,sheetId:sheet?.id,selectedRange,filter};
  const entries=useMemo(()=>new Map(draft?.entries.map(e=>[e.key,e])),[draft]);
  function value(r:number,c:number){const e=entries.get(key(r,c));return e?.displayValue??String(e?.operation.value??original(r,c))}
  const structural=(draft?.entries??[]).filter(entry=>entry.key.startsWith('grid-structure:'));
  const cellEditLocked=editingLocked||structural.length>0;
  function change(v:string){
    if(!ready||cellEditLocked||artifact.revision===undefined||!sheet||!editableCoordinate)return;
    const {row,col}=current;
    const formula=xlsx&&v.startsWith('=');
    const op=xlsx?(formula?'xlsx.set_formula':'xlsx.set_cell'):'set_cell';
    if(!supportsOperation(capabilities,xlsx?op:'edit'))return;
    const k=key(row,col);
    onDraft(artifact.revision,v===original(row,col)?null:{key:k,displayValue:v,label:sheet.name+' '+address(row,col),operation:xlsx?{op,sheetPart:sheet.part,address:address(row,col),value:formula?v:(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)&&Number.isFinite(Number(v))?Number(v):v)}:{op,row:sourceRow(row,col),col,value:v}},k);
  }
  const [formulaPreview,setFormulaPreview]=useState<{draft:NonNullable<typeof draft>;sheetId:string;cells:Map<string,string>}|null>(null);
  useEffect(()=>{
    if(!xlsx||!sheet||!draft||draft.baseRevision!==artifact.revision||mode!=='edit'||
      !structure.ready||visibleKeys.some(key=>!readTile(key)))return;
    const controller=new AbortController();
    const staged=new Map<string,FormulaCell>();
    const formulas=new Set<string>();
    const sources=new Map<string,Map<string,Cell>>();
    for(const key of visibleKeys){
      const tile=readTile(key)!;
      for(const cell of tile.cells.values())if(cell.formula)formulas.add(cell.address);
      sources.set(sheet.id+':'+key,tile.cells);
    }
    for(const e of draft.entries){
      const op=e.operation;
      if(typeof op.sheetPart!=='string'||typeof op.address!=='string'||!['xlsx.set_formula','xlsx.set_cell'].includes(op.op))continue;
      const v=op.value,formula=op.op==='xlsx.set_formula'?String(v).replace(/^=/,''):undefined;
      staged.set(op.sheetPart+':'+op.address,{value:v,type:typeof v==='number'?'n':'inlineStr',formula});
      const c=parseAddress(op.address);
      if(op.sheetPart===sheet.part&&c&&visibleKeys.includes(tileKey(c.row,c.col))){
        if(formula)formulas.add(op.address);else formulas.delete(op.address);
      }
    }
    if(!formulas.size)return;
    void previewFormulas({rootSheet:sheet,sheets,formulas,signal:controller.signal,loadCell:async(refSheet,row,col)=>{
      const id=address(row,col),override=staged.get(refSheet.part+':'+id);
      if(override)return override;
      const tile=tileKey(row,col),source=refSheet.id+':'+tile;
      let cells=sources.get(source)??(refSheet.id===sheet.id?readTile(tile)?.cells:undefined);
      if(!cells){
        const b=tileBounds(tile,rowCount,colCount);
        const result=await workspaceApi.range<{cells:Cell[]}>(artifact.id,{
          sheetId:refSheet.id,rangeA1:address(b.row0,b.col0)+':'+address(b.row1,b.col1),
        },controller.signal);
        assertRevision(artifact,result);
        cells=new Map(result.cells.map(cell=>[cell.address,cell]));
        sources.set(source,cells);
      }
      return cells.get(id);
    }}).then(cells=>{if(!controller.signal.aborted)setFormulaPreview({draft,sheetId:sheet.id,cells})},()=>{
      if(!controller.signal.aborted)setFormulaPreview(null);
    });
    return()=>controller.abort();
  },[xlsx,sheet,draft,mode,structure.ready,cache,cacheVersion,visibleKeys.join(',')]);
  const previews=formulaPreview?.draft===draft&&formulaPreview?.sheetId===sheet?.id?formulaPreview.cells:new Map<string,string>();
  function move(row:number,col:number,extend=false){
    row=Math.max(0,Math.min(rowCount-1,row));col=Math.max(0,Math.min(colCount-1,col));
    setSelected({row,col});if(!extend)setAnchor({row,col});
    pendingReveal.current={row,col};
  }
  useLayoutEffect(()=>{
    const el=scroll.current,target=pendingReveal.current;
    if(!el||!target||!structure.ready||!el.clientHeight||!el.clientWidth)return;
    pendingReveal.current=null;
    el.scrollTop=reveal(axis(rowCount,CELL_HEIGHT,CELL_HEIGHT,el.clientHeight,el.scrollTop),target.row);
    el.scrollLeft=reveal(axis(colCount,CELL_WIDTH,HEADER,el.clientWidth,el.scrollLeft),target.col);
    updateViewport();
  });
  function jumpToRange(){
    const parts=jump.split(':'),first=parseAddress(parts[0]),last=parts.length===2?parseAddress(parts[1]):first;
    if(parts.length>2||!first||!last||first.row>=rowCount||last.row>=rowCount||first.col>=colCount||last.col>=colCount){setPinError('有効なセル範囲を入力してください。');return}
    setPinError('');move(last.row,last.col);setAnchor(first);setJump('');
  }
  async function pin(){
    if(!ready||artifact.revision===undefined||!sheet||!inData)return;
    const {row0,row1,col0,col1}=bounds;
    const rangeLabel=selectedRange,identity=latest.current;
    let snippet:string|undefined;
    try{
      let selector:Record<string,unknown>&{kind:string};
      if(!xlsx){
        const exact=await workspaceApi.range<{rows:string[][];valuesHash:string;headerHash?:string;totalRows?:number;totalCols?:number;truncated?:boolean}>(artifact.id,{startRow:row0,endRow:row1,startCol:col0,endCol:col1,targetHashes:'true'});
        assertRevision(artifact,exact);
        if(exact.truncated||exact.rows.length!==row1-row0+1||!exact.valuesHash||!exact.headerHash||exact.totalRows===undefined||exact.totalCols===undefined){
          throw Error('選択対象を読み込めませんでした。');
        }
        selector={
          kind:'csv_range',
          startRow:row0,
          endRow:row1,
          startCol:col0,
          endCol:col1,
          expectedRowCount:exact.totalRows,
          expectedColCount:exact.totalCols,
          expectedHeaderHash:exact.headerHash,
          expectedRangeValuesHash:exact.valuesHash,
        };
        snippet=exact.rows.map(row=>row.join('\t')).join('\n');
      }else{
        const meta=await workspaceApi.range<{target:{sheetId:string;sheetName:string;rangeA1:string;expectedSheetStructHash:string;expectedRangeValuesHash:string;expectedOrderKeysHash?:string;snippet?:string}|null}>(artifact.id,{targetMetadata:'true',sheetId:sheet.id,rangeA1:rangeLabel});
        assertRevision(artifact,meta);
        if(!meta.target||!meta.target.expectedSheetStructHash||!meta.target.expectedRangeValuesHash){
          throw Error('選択対象を読み込めませんでした。');
        }
        selector={
          kind:'xlsx_range',
          sheetId:meta.target.sheetId,
          rangeA1:meta.target.rangeA1,
          expectedSheetStructHash:meta.target.expectedSheetStructHash,
          expectedRangeValuesHash:meta.target.expectedRangeValuesHash,
          ...(meta.target.expectedOrderKeysHash?{expectedOrderKeysHash:meta.target.expectedOrderKeysHash}:{}),
        };
        snippet=meta.target.snippet||(row0===row1&&col0===col1?original(row0,col0):undefined);
      }
      if(latest.current.revisionKey!==identity.revisionKey||latest.current.sheetId!==identity.sheetId||latest.current.selectedRange!==identity.selectedRange)return;
      onTarget({baseRevision:artifact.revision,label:sheet.name+' '+rangeLabel,selector,selectedContentSnapshot:snippet?.slice(0,50_000)});
      setPinError('');
    }catch{setPinError('選択対象を識別できませんでした。')}
  }
  const inputEnabled=ready&&editableCoordinate&&mode==='edit'&&!cellEditLocked;
  const structuralEnabled=ready&&editableCoordinate&&mode==='edit'&&!editingLocked&&artifact.revision!==undefined;
  const styleKey='style:'+key(current.row,current.col);
  const styleEntry=entries.get(styleKey);
  const canStyle=xlsx&&inputEnabled&&supportsOperation(capabilities,'xlsx.set_cell_style');
  function toggleBold(){if(!canStyle||!sheet||artifact.revision===undefined)return;const existing=raw(current.row,current.col)?.bold===true;const next=!(styleEntry?.operation.bold??existing);onDraft(artifact.revision,next===existing?null:{key:styleKey,label:address(current.row,current.col)+' 太字',operation:{op:'xlsx.set_cell_style',sheetPart:sheet.part,address:address(current.row,current.col),bold:next}},styleKey)}
  const actions=[{id:'insert_row',label:'行を挿入'},{id:'delete_row',label:'行を削除'},{id:'insert_col',label:'列を挿入'},{id:'delete_col',label:'列を削除'},...(xlsx?[{id:'xlsx.add_sheet',label:'シートを追加'},{id:'xlsx.rename_sheet',label:'シート名変更'},{id:'xlsx.remove_empty_sheet',label:'空のシートを削除'}]:[])].filter(action=>supportsOperation(capabilities,xlsx?(action.id.startsWith('xlsx.')?action.id:action.id.endsWith('row')?'xlsx.mutate_rows':'xlsx.mutate_columns'):'edit'));
  const needsName=['xlsx.add_sheet','xlsx.rename_sheet'].includes(editAction);
  const validName=!needsName||(sheetName.trim().length>0&&sheetName.trim().length<=31&&!Array.from('[]:*?/\\').some(ch=>sheetName.includes(ch))&&!sheets.some(s=>s.name.toLowerCase()===sheetName.trim().toLowerCase()&&(editAction!=='xlsx.rename_sheet'||s.id!==sheet?.id)));
  function stageStructure(){
    if(!structuralEnabled||!sheet||artifact.revision===undefined||!validName)return;
    const action=actions.find(a=>a.id===editAction);if(!action)return;
    const row=editAction.endsWith('row');
    let idx=row?sourceRow(current.row,current.col):current.col;
    const axisOp=row?'xlsx.mutate_rows':'xlsx.mutate_columns';
    for(const entry of structural){
      const op=entry.operation;
      if(xlsx&&op.op==='xlsx.remove_empty_sheet'&&op.sheetId===sheet.id){setPinError('このシートは削除予定です。');return}
      const matches=xlsx?op.sheetId===sheet.id&&op.op===axisOp:op.op===('insert_'+(row?'row':'col'))||op.op===('delete_'+(row?'row':'col'));
      if(!matches)continue;
      const prior=Number(op.index)-(xlsx?1:0);
      const insertion=xlsx?op.mode==='insert':op.op.startsWith('insert');
      if(!insertion&&prior===idx){setPinError('この行または列は削除予定です。');return}
      if(prior<=idx)idx+=insertion?1:-1;
    }
    if(!xlsx&&editAction.startsWith('delete')&&!inData)return;
    if(editAction.startsWith('delete')||editAction==='xlsx.remove_empty_sheet')if(!window.confirm(action.label+'しますか？'))return;
    const op=editAction.startsWith('xlsx.')?{op:editAction,sheetId:sheet.id,...(needsName?{name:sheetName.trim()}:{})}:xlsx?{op:row?'xlsx.mutate_rows':'xlsx.mutate_columns',sheetId:sheet.id,index:idx+1,count:1,mode:editAction.startsWith('insert')?'insert':'delete'}:{op:editAction,index:idx,...(editAction==='insert_row'?{values:Array.from({length:Math.max(1,csvCols)},()=> '')}:{})};
    setPinError('');
    const draftKey='grid-structure:'+(++structureSequence.current);
    onDraft(artifact.revision,{key:draftKey,label:action.label+' · '+selectedRange,operation:op},draftKey);setEditAction('');setSheetName('');
  }
  useEffect(()=>{setSearching(false);return()=>{searchAbort.current?.abort();searchAbort.current=null}},[search,revisionKey,sheet?.id,draft,filter]);
  async function nextMatch(){
    if(!search.trim()||!sheet||!structure.ready||searchAbort.current)return;
    const controller=new AbortController();searchAbort.current=controller;setSearching(true);setPinError('');
    const identity=latest.current,origin={row:sourceRow(current.row,current.col),col:current.col};
    const isStale=()=>controller.signal.aborted||latest.current.revisionKey!==identity.revisionKey||latest.current.sheetId!==identity.sheetId||latest.current.filter!==identity.filter;
    const fold=(s:string)=>Array.from(s,ch=>ch.toLowerCase()).join('');
    const q=fold(search.trim()),compare=(a:Coordinate,b:Coordinate)=>a.row-b.row||a.col-b.col;
    const circular=(a:Coordinate,b:Coordinate)=>Number(compare(a,origin)<=0)-Number(compare(b,origin)<=0)||compare(a,b);
    const matchingDrafts=(draft?.entries??[]).flatMap(e=>{
      const op=e.operation;
      if(!fold(String(op.value??'')).includes(q))return [];
      if(xlsx&&op.sheetPart===sheet.part&&['xlsx.set_cell','xlsx.set_formula'].includes(op.op)&&typeof op.address==='string'){
        const coordinate=parseAddress(op.address);
        return coordinate?[coordinate]:[];
      }
      return !xlsx&&op.op==='set_cell'&&Number.isSafeInteger(op.row)&&Number.isSafeInteger(op.col)?[{row:Number(op.row),col:Number(op.col)}]:[];
    }).sort(circular);
    try{
      let cursor=origin,hit:Coordinate|null=null;const seen=new Set<string>();
      // A staged cell may hide a match in the persisted bytes. Skip only
      // those overwritten hits; merge matching staged values in cyclic order.
      while(!isStale()){
        const result=await workspaceApi.range<{match:Coordinate|null}>(artifact.id,{gridSearch:search.trim(),afterRow:cursor.row,afterCol:cursor.col,...(xlsx?{sheetId:sheet.id}:{})},controller.signal);
        if(isStale())return;
        assertRevision(artifact,result);
        const next=result.match;if(!next)break;
        const addressKey=sheet.id+':'+address(next.row,next.col);if(seen.has(addressKey))break;seen.add(addressKey);
        const staged=entries.get(addressKey);
        if(!staged||fold(String(staged.operation.value??'')).includes(q)){hit=next;break;}
        cursor=next;
      }
      if(isStale()||latest.current.selectedRange!==identity.selectedRange)return;
      const candidate=matchingDrafts[0];if(candidate&&(!hit||circular(candidate,hit)<0))hit=candidate;
      if(hit){
        if(filter){setAppliedFilter('');setFilterInput('');setSelected(hit);setAnchor(hit);pendingReveal.current=hit}
        else move(hit.row,hit.col);
      }else setPinError('一致するセルがありません。');
    }catch(e){if(!isStale())setPinError(e instanceof Error?e.message:'検索に失敗しました。')}
    finally{if(searchAbort.current===controller){searchAbort.current=null;setSearching(false)}}
  }
  const activeFormulaStatus=raw(current.row,current.col)?.formulaStatus;
  const formulaWarning=(activeFormulaStatus==='unevaluated_unsupported'||activeFormulaStatus==='error_formula')
    && !entries.has(key(current.row,current.col)) && !previews.has(address(current.row,current.col));
  const primary=<><span className="workspace-cell-address" title={selectedRange}>{selectedRange}</span><span aria-hidden="true">ƒx</span><input ref={formulaInput} className="workspace-formula" aria-label="数式・セル値" value={ready?value(current.row,current.col):''} readOnly={!inputEnabled} onChange={e=>change(e.target.value)}/>{formulaWarning&&<small title={FORMULA_STATUS[activeFormulaStatus]}>{activeFormulaStatus==='error_formula'?'数式エラー':'未評価'}</small>}{mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!ready||!inData} onClick={()=>void pin()}>セルを対象にする</button>}{mode==='edit'&&<>
      {xlsx&&<button type="button" className="btn btn-secondary btn-xs" aria-pressed={Boolean(styleEntry?.operation.bold??raw(current.row,current.col)?.bold)} disabled={!canStyle} onClick={toggleBold}>太字</button>}
    </>}</>;
  const secondary=mode==='edit'?<>
      <select aria-label="表の編集操作" disabled={!structuralEnabled} value={editAction} onChange={e=>{setEditAction(e.target.value);setSheetName(e.target.value==='xlsx.rename_sheet'?sheet?.name??'':'')}}><option value="">表の操作…</option>{actions.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select>
      {needsName&&<input aria-label="シート名" value={sheetName} maxLength={31} onChange={e=>setSheetName(e.target.value)}/>}
      {editAction&&<button type="button" className="btn btn-secondary btn-xs" disabled={!structuralEnabled||!validName} onClick={stageStructure}>適用</button>}
    </>:null;
  const toolbar=<ResponsiveCommandBar primary={primary} secondary={secondary} minInlineWidth={850} closeOnButton/>;
  const sheetTabs=sheets.length>1&&<select aria-label="シート" value={sheet?.id??''}
    onChange={event=>{setSheetId(event.target.value);move(0,0)}}>
    {sheets.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
  </select>;
  const tabs=<ResponsiveCommandBar label="その他の表の移動操作" minInlineWidth={720}
    primary={<>{sheetTabs}<input className="workspace-command-input" aria-label={xlsx?'シート全体を検索':'表全体を検索'} placeholder={xlsx?'シート全体を検索':'表全体を検索'} value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void nextMatch()}}}/>
      <button type="button" className="btn btn-secondary btn-xs" disabled={!search.trim()||searching||!structure.ready} onClick={()=>void nextMatch()}>{searching?'検索中…':'次の一致'}</button></>}
    secondary={<><input aria-label="セル範囲へ移動" placeholder="A1:B2" value={jump} onChange={e=>setJump(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();jumpToRange()}}}/>
      <button type="button" className="btn btn-secondary btn-xs" disabled={!jump.trim()} onClick={jumpToRange}>移動</button></>}/>;
  const filters=!xlsx&&mode!=='pin'&&<form className="workspace-toolbar workspace-toolbar-fields" onSubmit={event=>{
    event.preventDefault();setAppliedFilter(filterInput.trim());move(0,0)
  }}>
    <input aria-label="行を絞り込む" placeholder="行を絞り込む" value={filterInput} onChange={event=>setFilterInput(event.target.value)}/>
    <button type="submit" className="btn btn-secondary btn-xs">絞り込む</button>
    {filter&&<button type="button" className="btn btn-ghost btn-xs" onClick={()=>{setFilterInput('');setAppliedFilter('');move(0,0)}}>絞り込み解除</button>}
  </form>;
  return <UnifiedViewerZoomShell resetKey={artifact.id+':grid'} controlsTop={<>{toolbar}{filters}</>} controlsBottom={tabs}>
    {(structure.error||rangeError||pinError)&&<div role="alert" className="error-box">{structure.error||rangeError||pinError}<button type="button" onClick={()=>{structure.retry();setRetry(v=>v+1);setPinError('')}}>再試行</button></div>}
    {structural.length>0&&<div className="workspace-toolbar workspace-toolbar-fields" role="status">
      {structural.map(entry=><span key={entry.key}>{entry.label}</span>)}
      <button type="button" className="btn btn-secondary btn-xs" disabled={editingLocked} onClick={()=>{
        const entry=structural.at(-1);if(entry&&artifact.revision!==undefined)onDraft(artifact.revision,null,entry.key)
      }}>最後の構造変更を取消</button>
    </div>}
    {filter&&structure.ready&&csvRows===0&&<p role="status">一致する行がありません。</p>}
    {!sheet?<div className="workspace-loading">{structure.error?'表を表示できません。':'読み込み中…'}</div>:<div className="workspace-virtual-grid" ref={scroll} role="grid" aria-label="表データ" aria-busy={loading} aria-rowcount={rowCount+1} aria-colcount={colCount+1} tabIndex={0} onScroll={updateViewport} onKeyDown={e=>{const delta:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};if(delta[e.key]){e.preventDefault();move(current.row+delta[e.key][0],current.col+delta[e.key][1],e.shiftKey)}else if(e.key==='Enter'&&mode==='edit'){e.preventDefault();formulaInput.current?.focus()}}}>
      <div className="workspace-grid-plane" style={{width:colAxis.plane,height:rowAxis.plane}}>
        <div role="row" className="workspace-grid-header" style={{height:CELL_HEIGHT}}><div role="columnheader" className="workspace-grid-corner" style={{width:HEADER}}/>{cols.map(c=><div key={colAxis.start+c.index} role="columnheader" className="workspace-grid-col" style={{left:c.start,width:c.size}}>{colName(colAxis.start+c.index)}</div>)}</div>
        {rows.map(r=>{const row=rowAxis.start+r.index;return <div key={row} role="row" aria-rowindex={row+2} className="workspace-grid-row" style={{top:r.start,height:r.size}}>
          <div role="rowheader" className="workspace-grid-rowhead" style={{width:HEADER}}>{sourceRow(row,current.col)+1}</div>
          {cols.map(c=>{const col=colAxis.start+c.index,addr=address(sourceRow(row,col),col),cell=raw(row,col),pending=entries.has(key(row,col)),active=row>=bounds.row0&&row<=bounds.row1&&col>=bounds.col0&&col<=bounds.col1,preview=previews.get(addr),loaded=!!tile(row,col);return <div key={col} role="gridcell" aria-colindex={col+2} aria-selected={active} aria-label={addr} aria-busy={!loaded} onClick={e=>{move(row,col,e.shiftKey);scroll.current?.focus({preventScroll:true})}} title={preview!==undefined?'未保存の数式プレビュー':cell?.formulaStatus?FORMULA_STATUS[cell.formulaStatus]:undefined} data-formula-preview={preview!==undefined?'true':undefined} className={'workspace-grid-cell'+(pending?' pending':'')} style={{left:c.start,width:c.size,fontWeight:entries.get('style:'+key(row,col))?.operation.bold??cell?.bold?'bold':undefined}}>{preview??(pending?value(row,col):!loaded?'…':xlsx?String(cell?.value??''):original(row,col))}</div>})}
        </div>})}
      </div>
    </div>}
  </UnifiedViewerZoomShell>
}
