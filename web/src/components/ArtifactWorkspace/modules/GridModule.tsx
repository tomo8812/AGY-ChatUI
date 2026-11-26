import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {previewFormulas,type FormulaCell} from '../formulaPreview';
import { workspaceApi,supportsOperation } from '../../../api/workspace';
import {ResponsiveCommandBar} from '../../shared-ui/layout/ResponsiveCommandBar';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import {artifactVersionKey,ByteLruCache} from '../../../utils/viewerCache';
import type { GridDraftLocation, WorkspaceModuleProps } from '../types';
import { gridAddress as address, gridAxisChanges, gridColumnName as colName, isGridStructureId, projectedGridIndex, savedGridOrigin } from '../gridDraft';

type Sheet={id:string;name:string;part:string};
const CELL_MARKS = { bold: '太字', italic: '斜体', underline: '下線', strike: '取り消し線' } as const;
type CellMark = keyof typeof CELL_MARKS;
type CellStyleField = CellMark|'horizontal'|'fontColor'|'backgroundColor';
const cellMarks = Object.keys(CELL_MARKS) as CellMark[];
const horizontalAlignment={general:'標準',left:'左揃え',center:'中央揃え',right:'右揃え'} as const;
type HorizontalAlignment=keyof typeof horizontalAlignment;
type Cell = Partial<Record<CellMark, boolean>> & {address:string;value:unknown;type?:string;formula?:string;formulaStatus?:string;horizontal?:string;fontColor?:string;backgroundColor?:string};
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
  const pendingSheetSelection=useRef<{name:string;revision:number}|null>(null);
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
  const storedSheets=structure.data?.sheets??[];
  const structural=useMemo(()=>(draft?.entries??[]).filter(entry=>isGridStructureId(entry.key)),[draft]);
  const sheets=useMemo(()=>{
    const next=[...storedSheets];
    for(const {key,operation} of structural){
      if(operation.op==='xlsx.add_sheet'){
        next.push({id:key,name:String(operation.name),part:key});
      }else if(operation.op==='xlsx.rename_sheet'||operation.op==='xlsx.remove_empty_sheet'){
        const index=next.findIndex(item=>item.id===operation.sheetId);
        if(index<0)continue;
        if(operation.op==='xlsx.rename_sheet')next[index]={...next[index],name:String(operation.name)};
        else next.splice(index,1);
      }
    }
    return next;
  },[storedSheets,structural]);
  const sheet=sheets.find(s=>s.id===sheetId)??sheets[0];
  const draftSheet=isGridStructureId(sheet?.id??'');
  useEffect(()=>{
    if(draftSheet&&sheet&&draft?.baseRevision===artifact.revision&&artifact.revision!==undefined){
      pendingSheetSelection.current={name:sheet.name,revision:artifact.revision};
    }
    const pending=pendingSheetSelection.current;
    if(!pending||!structure.ready||draft)return;
    if(artifact.revision!==undefined&&artifact.revision===pending.revision+1){
      const saved=storedSheets.find(item=>item.name===pending.name);
      if(saved)setSheetId(saved.id);
    }
    pendingSheetSelection.current=null;
  },[artifact.revision,draft,draftSheet,sheet,structure.ready,storedSheets]);
  const csvRows=structure.data?.rowCount??0,csvCols=structure.data?.colCount??0;
  const rowsChanged=gridAxisChanges(structural,sheet?.id??'', 'row');
  const colsChanged=gridAxisChanges(structural,sheet?.id??'', 'col');
  const projectedRows=filter?[]:rowsChanged;
  const projectedCols=filter?[]:colsChanged;
  const savedRowCount=xlsx?1048576:Math.max(1,csvRows),savedColCount=xlsx?16384:Math.max(1,csvCols);
  const rowDelta=projectedRows.reduce((delta,change)=>delta+(change.insert?1:-1),0);
  const colDelta=projectedCols.reduce((delta,change)=>delta+(change.insert?1:-1),0);
  let liveCsvRows=Math.max(0,csvRows+rowDelta),liveCsvCols=Math.max(0,csvCols+colDelta);
  if(!xlsx&&!filter){
    for(const entry of draft?.entries??[]){
      if(entry.operation.op!=='set_cell'||!entry.gridLocation)continue;
      const row=projectedGridIndex(entry.gridLocation.row,projectedRows);
      const col=projectedGridIndex(entry.gridLocation.col,projectedCols);
      if(row!==undefined&&col!==undefined){
        liveCsvRows=Math.max(liveCsvRows,row+1);
        liveCsvCols=Math.max(liveCsvCols,col+1);
      }
    }
  }
  const rowCount=xlsx?savedRowCount:Math.max(1,liveCsvRows),colCount=xlsx?savedColCount:Math.max(1,liveCsvCols);
  const rowOrigin=(row:number)=>savedGridOrigin(row,projectedRows,xlsx?savedRowCount:undefined);
  const colOrigin=(col:number)=>savedGridOrigin(col,projectedCols,xlsx?savedColCount:undefined);
  const csvEmpty=structure.ready&&!xlsx&&!filter&&liveCsvRows===0;
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
  const baseTileKey=(row:number,col:number)=>{
    const baseRow=rowOrigin(row),baseCol=colOrigin(col);
    return draftSheet||baseRow.insertedBy||baseCol.insertedBy?null:tileKey(baseRow.index,baseCol.index);
  };
  const rowTiles=new Set<number>();
  const colTiles=new Set<number>();
  for(let row=rowAxis.start;row<rowAxis.start+rowAxis.length;row++){
    const base=rowOrigin(row);
    if(!base.insertedBy)rowTiles.add(Math.floor(base.index/ROWS));
  }
  for(let col=colAxis.start;col<colAxis.start+colAxis.length;col++){
    const base=colOrigin(col);
    if(!base.insertedBy)colTiles.add(Math.floor(base.index/COLS));
  }
  const visibleKeys=draftSheet?[]:Array.from(rowTiles).flatMap(row=>Array.from(colTiles,col=>row+':'+col));
  const selectedTile=baseTileKey(current.row,current.col);
  const keys=[...new Set([...(selectedTile?[selectedTile]:[]),...visibleKeys])],keySignature=keys.join(',');
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
    if(!sheet||draftSheet||!structure.ready)return;
    const controller=new AbortController();setRangeError('');
    for(const key of activeTiles.keys())if(!keys.includes(key))activeTiles.delete(key);
    void(async()=>{
      for(const key of keys){
        if(controller.signal.aborted)return;
        const existing=cache.get(key)??activeTiles.get(key);
        if(existing){activeTiles.set(key,existing);continue;}
        const b=tileBounds(key,savedRowCount,savedColCount);
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
  },[cache,keySignature,retry,structure.ready,savedRowCount,savedColCount]);
  const tile=(r:number,c:number)=>{
    const key=baseTileKey(r,c);
    return key===null?undefined:readTile(key);
  };
  const raw=(r:number,c:number)=>xlsx?tile(r,c)?.cells.get(address(rowOrigin(r).index,colOrigin(c).index)):undefined;
  const sourceRow=(r:number,c:number)=>tile(r,c)?.sourceRows?.[r%ROWS]??rowOrigin(r).index;
  const location=(r:number,c:number):GridDraftLocation=>({
    sheetId:sheet?.id??'',row:filter?{index:sourceRow(r,c)}:rowOrigin(r),col:colOrigin(c),after:structural.at(-1)?.key,
  });
  const key=(r:number,c:number)=>{
    const {sheetId,row,col}=location(r,c);
    return sheetId+':'+(row.insertedBy||col.insertedBy
      ? JSON.stringify([row.insertedBy,row.index,col.insertedBy,col.index])
      : address(row.index,col.index));
  };
  function original(r:number,c:number){
    const cell=raw(r,c);
    return xlsx?cell?.formula?'='+cell.formula.replace(/^=/,''):String(cell?.value??''):
      String(tile(r,c)?.rows?.[rowOrigin(r).index%ROWS]?.[colOrigin(c).index%COLS]??'');
  }
  const ready=structure.ready&&!!sheet&&(selectedTile===null||!!tile(current.row,current.col));
  const inData=xlsx||current.row<liveCsvRows&&current.col<liveCsvCols;
  const editableCoordinate=inData||csvEmpty&&current.row===0&&current.col===0;
  const loading=structure.loading||keys.some(key=>!readTile(key));
  const latest=useRef({revisionKey,sheetId:sheet?.id,selectedRange,filter});latest.current={revisionKey,sheetId:sheet?.id,selectedRange,filter};
  const entries=useMemo(()=>new Map(draft?.entries.map(e=>[e.key,e])),[draft]);
  function value(r:number,c:number){const e=entries.get(key(r,c));return e?.displayValue??String(e?.operation.value??original(r,c))}
  const filteredRowRemoved=filter!==''&&(projectedGridIndex({index:sourceRow(current.row,current.col)},rowsChanged)===undefined||
    projectedGridIndex({index:current.col},colsChanged)===undefined);
  const cellEditLocked=editingLocked||filteredRowRemoved;
  function change(v:string){
    if(!ready||cellEditLocked||artifact.revision===undefined||!sheet||!editableCoordinate)return;
    const {row,col}=current;
    const formula=xlsx&&v.startsWith('=');
    const op=xlsx?(formula?'xlsx.set_formula':'xlsx.set_cell'):'set_cell';
    if(!supportsOperation(capabilities,xlsx?op:'edit'))return;
    const k=key(row,col);
    const gridLocation=location(row,col);
    const cellValue=formula?v:(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)&&Number.isFinite(Number(v))?Number(v):v);
    onDraft(artifact.revision,v===original(row,col)?null:{key:k,displayValue:v,label:sheet.name+' '+address(row,col),gridLocation,
      operation:xlsx?{op,sheetPart:sheet.part,address:address(gridLocation.row.index,gridLocation.col.index),value:cellValue}:{op,row:gridLocation.row.index,col:gridLocation.col.index,value:v}},k);
  }
  const [formulaPreview,setFormulaPreview]=useState<{draft:NonNullable<typeof draft>;sheetId:string;cells:Map<string,string>}|null>(null);
  useEffect(()=>{
    if(!xlsx||!sheet||!draft||rowsChanged.length||colsChanged.length||draft.baseRevision!==artifact.revision||mode!=='edit'||
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
      if(isGridStructureId(refSheet.id))return undefined;
      const tile=tileKey(row,col),source=refSheet.id+':'+tile;
      let cells=sources.get(source)??(refSheet.id===sheet.id?readTile(tile)?.cells:undefined);
      if(!cells){
        const b=tileBounds(tile,savedRowCount,savedColCount);
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
  const previews=!rowsChanged.length&&!colsChanged.length&&formulaPreview?.draft===draft&&formulaPreview?.sheetId===sheet?.id?formulaPreview.cells:new Map<string,string>();
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
  function stageCellStyle(field: CellStyleField, next: boolean|string, original: boolean|string|undefined) {
    if (!canStyle || !sheet || artifact.revision === undefined) return;
    const cellAddress = address(current.row, current.col);
    const operation: Record<string, unknown> & { op: string } = { op: 'xlsx.set_cell_style', sheetPart: sheet.part, address: cellAddress, ...styleEntry?.operation };
    if (next === original) delete operation[field];
    else operation[field] = next;
    const changed = [...cellMarks,'horizontal','fontColor','backgroundColor'].some(field => operation[field] !== undefined);
    onDraft(artifact.revision, changed ? { key: styleKey, label: cellAddress + ' の書式', operation, gridLocation:location(current.row,current.col) } : null, styleKey);
  }
  const selectedCell=raw(current.row,current.col);
  const markButton=(mark:CellMark)=>{
    const original=selectedCell?.[mark]===true;
    const active=Boolean(styleEntry?.operation[mark]??original);
    return <button key={mark} type="button" className="btn btn-secondary btn-xs" aria-pressed={active} disabled={!canStyle}
      data-keep-open onClick={()=>stageCellStyle(mark,!active,original)}>{CELL_MARKS[mark]}</button>;
  };
  const cellAlignment=selectedCell?.horizontal??'general';
  const selectedAlignment=String(styleEntry?.operation.horizontal??cellAlignment);
  const colorControl=(field:'fontColor'|'backgroundColor',label:string,fallback:string)=>{
    const original=selectedCell?.[field];
    const active=String(styleEntry?.operation[field]??original??'');
    return <label className="workspace-cell-color">{label}<input type="color" aria-label={label}
      value={/^#[0-9a-f]{6}$/i.test(active)?active:fallback} disabled={!canStyle}
      onChange={event=>stageCellStyle(field,event.target.value,original)}/></label>;
  };
  function cellFontStyle(row: number, col: number): React.CSSProperties {
    const cell = raw(row, col);
    const style = entries.get('style:' + key(row, col))?.operation;
    const hasMark = (mark: CellMark) => style?.[mark] ?? cell?.[mark];
    const alignment=style?.horizontal??cell?.horizontal;
    const color=String(style?.fontColor??cell?.fontColor??'');
    const background=String(style?.backgroundColor??cell?.backgroundColor??'');
    return {
      color:/^#[0-9a-f]{6}$/i.test(color)?color:undefined,
      backgroundColor:/^#[0-9a-f]{6}$/i.test(background)?background:undefined,
      textAlign:alignment==='left'||alignment==='center'||alignment==='right'?alignment:undefined,
      fontWeight: hasMark('bold') ? 'bold' : undefined,
      fontStyle: hasMark('italic') ? 'italic' : undefined,
      textDecorationLine: [hasMark('underline') && 'underline', hasMark('strike') && 'line-through'].filter(Boolean).join(' ') || undefined,
    };
  }
  const actions=[{id:'insert_row',label:'行を挿入'},{id:'delete_row',label:'行を削除'},{id:'insert_col',label:'列を挿入'},{id:'delete_col',label:'列を削除'},...(xlsx?[{id:'xlsx.add_sheet',label:'シートを追加'},{id:'xlsx.rename_sheet',label:'シート名変更'},{id:'xlsx.remove_empty_sheet',label:'空のシートを削除'}]:[])].filter(action=>supportsOperation(capabilities,xlsx?(action.id.startsWith('xlsx.')?action.id:action.id.endsWith('row')?'xlsx.mutate_rows':'xlsx.mutate_columns'):'edit')&&(action.id!=='xlsx.remove_empty_sheet'||sheets.length>1));
  const needsName=['xlsx.add_sheet','xlsx.rename_sheet'].includes(editAction);
  const validName=!needsName||(sheetName.trim().length>0&&sheetName.trim().length<=31&&!Array.from('[]:*?/\\').some(ch=>sheetName.includes(ch))&&!sheets.some(s=>s.name.toLowerCase()===sheetName.trim().toLowerCase()&&(editAction!=='xlsx.rename_sheet'||s.id!==sheet?.id)));
  function stageStructure(){
    if(!structuralEnabled||!sheet||artifact.revision===undefined||!validName)return;
    const action=actions.find(a=>a.id===editAction);if(!action)return;
    const row=editAction.endsWith('row');
    const idx=filter
      ? projectedGridIndex({index:row?sourceRow(current.row,current.col):current.col},row?rowsChanged:colsChanged)
      : row?current.row:current.col;
    if(idx===undefined){setPinError('この行または列は削除予定です。');return}
    if(!xlsx&&editAction.startsWith('delete')&&!inData)return;
    if(editAction.startsWith('delete')||editAction==='xlsx.remove_empty_sheet')if(!window.confirm(action.label+'しますか？'))return;
    const op=editAction.startsWith('xlsx.')?{op:editAction,sheetId:sheet.id,...(needsName?{name:sheetName.trim()}:{})}:xlsx?{op:row?'xlsx.mutate_rows':'xlsx.mutate_columns',sheetId:sheet.id,index:idx+1,count:1,mode:editAction.startsWith('insert')?'insert':'delete'}:{op:editAction,index:idx,...(editAction==='insert_row'?{values:Array.from({length:Math.max(1,liveCsvCols)},()=> '')}:{})};
    setPinError('');
    const draftKey='grid-structure:'+(++structureSequence.current);
    onDraft(artifact.revision,{key:draftKey,label:action.label+' · '+selectedRange,operation:op},draftKey);
    if(op.op==='xlsx.add_sheet'){
      pendingSheetSelection.current={name:sheetName.trim(),revision:artifact.revision};
      setSheetId(draftKey);move(0,0);
    }else if(op.op==='xlsx.rename_sheet'&&draftSheet){
      pendingSheetSelection.current={name:sheetName.trim(),revision:artifact.revision};
    }
    setEditAction('');setSheetName('');
  }
  useEffect(()=>{setSearching(false);return()=>{searchAbort.current?.abort();searchAbort.current=null}},[search,revisionKey,sheet?.id,draft,filter]);
  async function nextMatch(){
    if(!search.trim()||!sheet||!structure.ready||searchAbort.current)return;
    const controller=new AbortController();searchAbort.current=controller;setSearching(true);setPinError('');
    const identity=latest.current;
    const active=location(current.row,current.col);
    const toProjected=(base:Pick<GridDraftLocation,'row'|'col'>):Coordinate|null=>{
      const row=projectedGridIndex(base.row,rowsChanged),col=projectedGridIndex(base.col,colsChanged);
      return row===undefined||col===undefined?null:{row,col};
    };
    const origin=toProjected(active)??current;
    let priorRow=current.row,priorCol=current.col;
    if(!filter){
      while(priorRow>=0&&rowOrigin(priorRow).insertedBy){priorRow--;priorCol=colCount-1}
      while(priorCol>=0&&colOrigin(priorCol).insertedBy)priorCol--;
      if(priorCol<0){priorRow--;priorCol=colCount-1}
    }
    const nativeOrigin={
      row:priorRow<0?savedRowCount-1:sourceRow(priorRow,Math.max(0,priorCol)),
      col:priorRow<0?savedColCount-1:colOrigin(priorCol).index,
    };
    const isStale=()=>controller.signal.aborted||latest.current.revisionKey!==identity.revisionKey||latest.current.sheetId!==identity.sheetId||latest.current.filter!==identity.filter;
    const fold=(s:string)=>Array.from(s,ch=>ch.toLowerCase()).join('');
    const q=fold(search.trim()),compare=(a:Coordinate,b:Coordinate)=>a.row-b.row||a.col-b.col;
    const circular=(a:Coordinate,b:Coordinate)=>Number(compare(a,origin)<=0)-Number(compare(b,origin)<=0)||compare(a,b);
    const matchingDrafts=(draft?.entries??[]).flatMap(e=>{
      const op=e.operation;
      if(!e.gridLocation||e.gridLocation.sheetId!==sheet.id||
        !['set_cell','xlsx.set_cell','xlsx.set_formula'].includes(op.op)||!fold(String(op.value??'')).includes(q))return [];
      const coordinate=toProjected(e.gridLocation);
      return coordinate?[coordinate]:[];
    }).sort(circular);
    try{
      let cursor=nativeOrigin,hit:Coordinate|null=null;const seen=new Set<string>();
      // A staged cell may hide a match in the persisted bytes. Skip only
      // those overwritten hits; merge matching staged values in cyclic order.
      while(!draftSheet&&!isStale()){
        const result=await workspaceApi.range<{match:Coordinate|null}>(artifact.id,{gridSearch:search.trim(),afterRow:cursor.row,afterCol:cursor.col,...(xlsx?{sheetId:sheet.id}:{})},controller.signal);
        if(isStale())return;
        assertRevision(artifact,result);
        const next=result.match;if(!next)break;
        const addressKey=sheet.id+':'+address(next.row,next.col);if(seen.has(addressKey))break;seen.add(addressKey);
        const staged=entries.get(addressKey);
        const projected=toProjected({row:{index:next.row},col:{index:next.col}});
        if(projected&&(!staged||fold(String(staged.operation.value??'')).includes(q))){hit=projected;break;}
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
      {xlsx&&markButton('bold')}
    </>}</>;
  const secondary=mode==='edit'?<>
      {xlsx&&<>
        {cellMarks.filter(mark=>mark!=='bold').map(markButton)}
        {colorControl('fontColor','文字色','#000000')}
        {colorControl('backgroundColor','塗りつぶし','#ffffff')}
        <button type="button" className="btn btn-secondary btn-xs" disabled={!canStyle} data-keep-open
          onClick={()=>stageCellStyle('backgroundColor','none',selectedCell?.backgroundColor)}>塗りつぶしなし</button>
        <select aria-label="セルの配置" value={selectedAlignment in horizontalAlignment?selectedAlignment:''} disabled={!canStyle}
          onChange={event=>stageCellStyle('horizontal',event.target.value as HorizontalAlignment,cellAlignment)}>
          <option value="" disabled>既存の配置</option>
          {Object.entries(horizontalAlignment).map(([id,label])=><option value={id} key={id}>{label}</option>)}
        </select>
      </>}
      <select aria-label="表の編集操作" disabled={!structuralEnabled} value={editAction} onChange={e=>{setEditAction(e.target.value);setSheetName(e.target.value==='xlsx.rename_sheet'?sheet?.name??'':'')}}><option value="">表の操作…</option>{actions.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select>
      {needsName&&<input aria-label="シート名" value={sheetName} maxLength={31} onChange={e=>setSheetName(e.target.value)}/>}
      {editAction&&<button type="button" className="btn btn-secondary btn-xs" disabled={!structuralEnabled||!validName} onClick={stageStructure}>適用</button>}
    </>:null;
  const toolbar=<ResponsiveCommandBar primary={primary} secondary={secondary} minInlineWidth={850} closeOnButton/>;
  const selectSheet=(id:string)=>{
    const selected=sheets.find(item=>item.id===id);
    pendingSheetSelection.current=selected&&isGridStructureId(id)&&artifact.revision!==undefined
      ? {name:selected.name,revision:artifact.revision}
      : null;
    setSheetId(id);move(0,0);
  };
  const sheetTabs=sheets.length>1&&<div className={'workspace-sheet-switcher'+(sheets.length<=3?' has-tabs':'')}>
    <select aria-label="シート" value={sheet?.id??''} onChange={event=>selectSheet(event.target.value)}>
      {sheets.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
    {sheets.length<=3&&<div className="workspace-sheet-tabs" role="group" aria-label="シート">
      {sheets.map(s=><button key={s.id} type="button" className="btn btn-secondary btn-xs" title={s.name}
        aria-pressed={s.id===sheet?.id} onClick={()=>selectSheet(s.id)}>{s.name}</button>)}
    </div>}
  </div>;
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
      <span>{filter?'絞り込み解除で行・列の変更を確認できます。':'行・列・シートの変更を編集中'}</span>
      {structural.map(entry=><span key={entry.key}>{entry.label}</span>)}
      <button type="button" className="btn btn-secondary btn-xs" disabled={editingLocked} onClick={()=>{
        const entry=structural.at(-1);
        const revision=artifact.revision;
        if(!entry||revision===undefined)return;
        for(const cell of draft?.entries??[]){
          if(cell.gridLocation?.sheetId===entry.key||cell.gridLocation?.row.insertedBy===entry.key||cell.gridLocation?.col.insertedBy===entry.key){
            onDraft(revision,null,cell.key);
          }
        }
        onDraft(revision,null,entry.key);
      }}>最後の構造変更を取消</button>
    </div>}
    {filter&&structure.ready&&csvRows===0&&<p role="status">一致する行がありません。</p>}
    {!sheet?<div className="workspace-loading">{structure.error?'表を表示できません。':'読み込み中…'}</div>:<div className="workspace-virtual-grid" ref={scroll} role="grid" aria-label="表データ" aria-busy={loading} aria-rowcount={rowCount+1} aria-colcount={colCount+1} tabIndex={0} onScroll={updateViewport} onKeyDown={e=>{const delta:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};if(delta[e.key]){e.preventDefault();move(current.row+delta[e.key][0],current.col+delta[e.key][1],e.shiftKey)}else if(e.key==='Enter'&&mode==='edit'){e.preventDefault();formulaInput.current?.focus()}}}>
      <div className="workspace-grid-plane" style={{width:colAxis.plane,height:rowAxis.plane}}>
        <div role="row" className="workspace-grid-header" style={{height:CELL_HEIGHT}}><div role="columnheader" className="workspace-grid-corner" style={{width:HEADER}}/>{cols.map(c=><div key={colAxis.start+c.index} role="columnheader" className="workspace-grid-col" style={{left:c.start,width:c.size}}>{colName(colAxis.start+c.index)}</div>)}</div>
        {rows.map(r=>{const row=rowAxis.start+r.index;return <div key={row} role="row" aria-rowindex={row+2} className="workspace-grid-row" style={{top:r.start,height:r.size}}>
          <div role="rowheader" className="workspace-grid-rowhead" style={{width:HEADER}}>{(filter?sourceRow(row,current.col):row)+1}</div>
          {cols.map(c=>{const col=colAxis.start+c.index,addr=address(filter?sourceRow(row,col):row,col),cell=raw(row,col),pending=entries.has(key(row,col)),active=row>=bounds.row0&&row<=bounds.row1&&col>=bounds.col0&&col<=bounds.col1,preview=previews.get(addr),loaded=baseTileKey(row,col)===null||!!tile(row,col);return <div key={col} role="gridcell" aria-colindex={col+2} aria-selected={active} aria-label={addr} aria-busy={!loaded} onClick={e=>{move(row,col,e.shiftKey);scroll.current?.focus({preventScroll:true})}} title={preview!==undefined?'未保存の数式プレビュー':cell?.formulaStatus?FORMULA_STATUS[cell.formulaStatus]:undefined} data-formula-preview={preview!==undefined?'true':undefined} className={'workspace-grid-cell'+(pending?' pending':'')} style={{left:c.start,width:c.size,...cellFontStyle(row,col)}}>{preview??(pending?value(row,col):!loaded?'…':xlsx?String(cell?.value??''):original(row,col))}</div>})}
        </div>})}
      </div>
    </div>}
  </UnifiedViewerZoomShell>
}
