import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {previewFormulas} from '../formulaPreview';
import { workspaceApi,supportsOperation } from '../../../api/workspace';
import {ResponsiveCommandBar} from '../../shared-ui/layout/ResponsiveCommandBar';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import {artifactVersionKey,ByteLruCache} from '../../../utils/viewerCache';
import type { WorkspaceModuleProps } from '../types';

type Sheet={id:string;name:string;part:string};
type Cell={address:string;value:unknown;type?:string;formula?:string;formulaStatus?:string;bold?:boolean};
type Coordinate={row:number;col:number};
type GridTile={cells:Map<string,Cell>;rows?:string[][]};
type CsvRange={rows:string[][];truncated?:boolean};
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
async function csvTile(artifact:WorkspaceModuleProps['artifact'],r0:number,r1:number,c0:number,c1:number,signal:AbortSignal):Promise<string[][]>{
  const result=await workspaceApi.range<CsvRange>(artifact.id,{startRow:r0,endRow:r1,startCol:c0,endCol:c1},signal);
  assertRevision(artifact,result);
  if(!result.truncated)return result.rows;
  // A response byte budget is a transport bound, not a spreadsheet limit.
  // Subdivide only when necessary; never silently treat truncated values as blanks.
  if(r0<r1){const middle=Math.floor((r0+r1)/2);return [...await csvTile(artifact,r0,middle,c0,c1,signal),...await csvTile(artifact,middle+1,r1,c0,c1,signal)]}
  if(c0<c1){
    const middle=Math.floor((c0+c1)/2),left=await csvTile(artifact,r0,r1,c0,middle,signal),right=await csvTile(artifact,r0,r1,middle+1,c1,signal);
    return left.map((row,i)=>[...row,...(right[i]?.length?Array(Math.max(0,middle-c0+1-row.length)).fill(''):[]),...(right[i]??[])]);
  }
  throw Error('セルの内容が読み取り上限を超えています。');
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
  const [search,setSearch]=useState('');
  const [searching,setSearching]=useState(false);
  const searchAbort=useRef<AbortController|null>(null);
  const formulaInput=useRef<HTMLInputElement>(null);
  const scroll=useRef<HTMLDivElement>(null);
  const pendingReveal=useRef<Coordinate|null>(null);
  const [viewport,setViewport]=useState({top:0,left:0,width:800,height:420});
  const structure=useRevisionResource<{sheets:Sheet[];rowCount?:number;colCount?:number}>(artifact,'grid-structure',async signal=>{
    if(xlsx){
      const result=await workspaceApi.structure<{sheets:Sheet[]}>(artifact.id,signal);assertRevision(artifact,result);return result;
    }
    const result=await workspaceApi.range<{totalRows:number;totalCols:number}>(artifact.id,{gridDimensions:true},signal);
    assertRevision(artifact,result);
    if(!Number.isSafeInteger(result.totalRows)||result.totalRows<0||!Number.isSafeInteger(result.totalCols)||result.totalCols<0)throw Error('表のサイズを取得できません。');
    return {sheets:[{id:'csv',name:artifact.filename,part:''}],rowCount:result.totalRows,colCount:result.totalCols};
  });
  const sheets=structure.data?.sheets??[];
  const sheet=sheets.find(s=>s.id===sheetId)??sheets[0];
  const csvRows=structure.data?.rowCount??0,csvCols=structure.data?.colCount??0;
  const rowCount=xlsx?1048576:Math.max(1,csvRows),colCount=xlsx?16384:Math.max(1,csvCols);
  const csvEmpty=structure.ready&&!xlsx&&csvRows===0;
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
  useEffect(()=>{if(current.row!==selected.row||current.col!==selected.col){setSelected(current);setAnchor(current)}},[rowCount,colCount]);
  const bounds={row0:Math.min(anchor.row,current.row),row1:Math.max(anchor.row,current.row),col0:Math.min(anchor.col,current.col),col1:Math.max(anchor.col,current.col)};
  const selectedRange=address(bounds.row0,bounds.col0)+(bounds.row0===bounds.row1&&bounds.col0===bounds.col1?'':':'+address(bounds.row1,bounds.col1));
  const visibleKeys:string[]=[];
  for(let r=Math.floor(rowAxis.start/ROWS);r<=Math.floor((rowAxis.start+rowAxis.length-1)/ROWS);r++)
    for(let c=Math.floor(colAxis.start/COLS);c<=Math.floor((colAxis.start+colAxis.length-1)/COLS);c++)visibleKeys.push(r+':'+c);
  const keys=[...new Set([tileKey(current.row,current.col),...visibleKeys])],keySignature=keys.join(',');
  const revisionKey=artifactVersionKey(artifact);
  const cache=useMemo(()=>new ByteLruCache<string,GridTile>({maxEntries:48,maxBytes:24*1024*1024,maxSingleEntryBytes:20*1024*1024,sizeOf:tile=>JSON.stringify(tile.rows??[...tile.cells.values()]).length*2+tile.cells.size*96}),[artifact.userId,revisionKey,sheet?.id]);
  const [cacheVersion,setCacheVersion]=useState(0),[retry,setRetry]=useState(0);
  const [rangeError,setRangeError]=useState('');
  useEffect(()=>{
    if(!sheet||!structure.ready)return;
    const controller=new AbortController();setRangeError('');
    void(async()=>{
      for(const key of keys){
        if(controller.signal.aborted)return;
        if(cache.get(key))continue;
        const b=tileBounds(key,rowCount,colCount);
        try{
          let tile:GridTile;
          if(xlsx){
            const result=await workspaceApi.range<{cells:Cell[]}>(artifact.id,{sheetId:sheet.id,rangeA1:address(b.row0,b.col0)+':'+address(b.row1,b.col1),evaluate:true},controller.signal);
            assertRevision(artifact,result);
            tile={cells:new Map(result.cells.map(cell=>[cell.address,cell]))};
          }else tile={cells:new Map(),rows:await csvTile(artifact,b.row0,b.row1,b.col0,b.col1,controller.signal)};
          if(controller.signal.aborted)return;
          cache.set(key,tile);
          if(!cache.has(key))throw Error('表示範囲のデータが大きすぎます。');
          setCacheVersion(v=>v+1);
        }catch(e){if(!controller.signal.aborted)setRangeError(e instanceof Error?e.message:'表を読み込めません。')}
      }
    })();
    return()=>controller.abort();
  },[cache,keySignature,retry,structure.ready,rowCount,colCount]);
  const tile=(r:number,c:number)=>cache.peek(tileKey(r,c));
  const raw=(r:number,c:number)=>xlsx?tile(r,c)?.cells.get(address(r,c)):undefined;
  const key=(r:number,c:number)=>String(sheet?.id)+':'+address(r,c);
  function original(r:number,c:number){const cell=raw(r,c);return xlsx?cell?.formula?'='+cell.formula.replace(/^=/,''):String(cell?.value??''):String(tile(r,c)?.rows?.[r%ROWS]?.[c%COLS]??'')}
  const ready=structure.ready&&!!sheet&&!!tile(current.row,current.col);
  const inData=xlsx||current.row<csvRows&&current.col<csvCols;
  const editableCoordinate=inData||csvEmpty&&current.row===0&&current.col===0;
  const loading=structure.loading||keys.some(key=>!cache.has(key));
  const latest=useRef({revisionKey,sheetId:sheet?.id,selectedRange});latest.current={revisionKey,sheetId:sheet?.id,selectedRange};
  const entries=useMemo(()=>new Map(draft?.entries.map(e=>[e.key,e])),[draft]);
  function value(r:number,c:number){const e=entries.get(key(r,c));return e?.displayValue??String(e?.operation.value??original(r,c))}
  const structural=entries.get('grid-structure');
  const cellEditLocked=editingLocked||!!structural;
  function change(v:string){
    if(!ready||cellEditLocked||artifact.revision===undefined||!sheet||!editableCoordinate)return;
    const {row,col}=current;
    const formula=xlsx&&v.startsWith('=');
    const op=xlsx?(formula?'xlsx.set_formula':'xlsx.set_cell'):'set_cell';
    if(!supportsOperation(capabilities,xlsx?op:'edit'))return;
    const k=key(row,col);
    onDraft(artifact.revision,v===original(row,col)?null:{key:k,displayValue:v,label:sheet.name+' '+address(row,col),operation:xlsx?{op,sheetPart:sheet.part,address:address(row,col),value:formula?v:(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)&&Number.isFinite(Number(v))?Number(v):v)}:{op,row,col,value:v}},k);
  }
  const previews=useMemo(()=>{
    if(!xlsx||!sheet||!draft||!structure.ready||visibleKeys.some(key=>!cache.has(key)))return new Map<string,string>();
    const first=tileBounds(visibleKeys[0],rowCount,colCount),last=tileBounds(visibleKeys[visibleKeys.length-1],rowCount,colCount);
    const values=new Map<string,{value:unknown;type?:string;formula?:string}>();
    for(const key of visibleKeys)for(const cell of cache.peek(key)!.cells.values())values.set(cell.address,cell);
    for(const e of draft.entries){
      const op=e.operation;
      if(op.sheetPart!==sheet.part||typeof op.address!=='string'||!['xlsx.set_formula','xlsx.set_cell'].includes(op.op))continue;
      const v=op.value;
      values.set(op.address,{value:v,type:typeof v==='number'?'n':'inlineStr',formula:op.op==='xlsx.set_formula'?String(v).replace(/^=/,''):undefined});
    }
    return previewFormulas(values,sheet.name,{row0:first.row0,col0:first.col0,rows:last.row1-first.row0+1,cols:last.col1-first.col0+1});
  },[xlsx,sheet,draft,structure.ready,cache,cacheVersion,visibleKeys.join(',')]);
  function move(row:number,col:number,extend=false){
    row=Math.max(0,Math.min(rowCount-1,row));col=Math.max(0,Math.min(colCount-1,col));
    setSelected({row,col});if(!extend)setAnchor({row,col});
    pendingReveal.current={row,col};
  }
  useLayoutEffect(()=>{
    const el=scroll.current,target=pendingReveal.current;
    if(!el||!target||!el.clientHeight||!el.clientWidth)return;
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
      let selector:Record<string,unknown>&{kind:string}={kind:'xlsx_range',sheetId:sheet.id,rangeA1:rangeLabel,expectedRangeValuesHash:artifact.sha256};
      if(!xlsx){
        const exact=await workspaceApi.range<{rows:string[][];valuesHash:string;truncated?:boolean}>(artifact.id,{startRow:row0,endRow:row1,startCol:col0,endCol:col1});
        assertRevision(artifact,exact);
        if(exact.truncated||exact.rows.length!==row1-row0+1||!exact.valuesHash)throw Error('選択対象を読み込めませんでした。');
        selector={kind:'csv_range',startRow:row0,endRow:row1,startCol:col0,endCol:col1,expectedRangeValuesHash:exact.valuesHash};
        snippet=exact.rows.map(row=>row.join('\t')).join('\n');
      }else if(row0===row1&&col0===col1)snippet=original(row0,col0);
      else if((row1-row0+1)*(col1-col0+1)<=1000){
        const exact=await workspaceApi.range<{cells:Cell[]}>(artifact.id,{sheetId:sheet.id,rangeA1:rangeLabel});
        assertRevision(artifact,exact);snippet=exact.cells.map(c=>c.address+' '+String(c.formula?'='+c.formula:c.value??'')).join('\n');
      }
      if(latest.current.revisionKey!==identity.revisionKey||latest.current.sheetId!==identity.sheetId||latest.current.selectedRange!==identity.selectedRange)return;
      onTarget({baseRevision:artifact.revision,label:sheet.name+' '+rangeLabel,selector,selectedContentSnapshot:snippet});
      setPinError('');
    }catch{setPinError('選択対象を識別できませんでした。')}
  }
  const inputEnabled=ready&&editableCoordinate&&mode==='edit'&&!cellEditLocked;
  const structuralEnabled=ready&&editableCoordinate&&mode==='edit'&&!editingLocked&&(!draft||!!structural)&&artifact.revision!==undefined;
  const styleKey='style:'+key(current.row,current.col);
  const styleEntry=entries.get(styleKey);
  const canStyle=xlsx&&inputEnabled&&supportsOperation(capabilities,'xlsx.set_cell_style');
  function toggleBold(){if(!canStyle||!sheet||artifact.revision===undefined)return;const existing=raw(current.row,current.col)?.bold===true;const next=!(styleEntry?.operation.bold??existing);onDraft(artifact.revision,next===existing?null:{key:styleKey,label:address(current.row,current.col)+' 太字',operation:{op:'xlsx.set_cell_style',sheetPart:sheet.part,address:address(current.row,current.col),bold:next}},styleKey)}
  const actions=[{id:'insert_row',label:'行を挿入'},{id:'delete_row',label:'行を削除'},{id:'insert_col',label:'列を挿入'},{id:'delete_col',label:'列を削除'},...(xlsx?[{id:'xlsx.add_sheet',label:'シートを追加'},{id:'xlsx.rename_sheet',label:'シート名変更'},{id:'xlsx.remove_empty_sheet',label:'空のシートを削除'}]:[])].filter(action=>supportsOperation(capabilities,xlsx?(action.id.startsWith('xlsx.')?action.id:action.id.endsWith('row')?'xlsx.mutate_rows':'xlsx.mutate_columns'):'edit'));
  const needsName=['xlsx.add_sheet','xlsx.rename_sheet'].includes(editAction);
  const validName=!needsName||(sheetName.trim().length>0&&sheetName.trim().length<=31&&!Array.from('[]:*?/\\').some(ch=>sheetName.includes(ch))&&!sheets.some(s=>s.name.toLowerCase()===sheetName.trim().toLowerCase()&&(editAction!=='xlsx.rename_sheet'||s.id!==sheet?.id)));
  function stageStructure(){
    if(!structuralEnabled||structural||!sheet||artifact.revision===undefined||!validName)return;
    const action=actions.find(a=>a.id===editAction);if(!action)return;
    const row=editAction.endsWith('row'),idx=row?current.row:current.col;
    if(!xlsx&&editAction.startsWith('delete')&&!inData)return;
    if(editAction.startsWith('delete')||editAction==='xlsx.remove_empty_sheet')if(!window.confirm(action.label+'しますか？'))return;
    const op=editAction.startsWith('xlsx.')?{op:editAction,sheetId:sheet.id,...(needsName?{name:sheetName.trim()}:{})}:xlsx?{op:row?'xlsx.mutate_rows':'xlsx.mutate_columns',sheetId:sheet.id,index:idx+1,count:1,mode:editAction.startsWith('insert')?'insert':'delete'}:{op:editAction,index:idx,...(editAction==='insert_row'?{values:Array.from({length:Math.max(1,csvCols)},()=> '')}:{})};
    onDraft(artifact.revision,{key:'grid-structure',label:action.label,operation:op},'grid-structure');setEditAction('');setSheetName('');
  }
  useEffect(()=>{setSearching(false);return()=>{searchAbort.current?.abort();searchAbort.current=null}},[search,revisionKey,sheet?.id,draft]);
  async function nextMatch(){
    if(!search.trim()||!sheet||searching)return;
    searchAbort.current?.abort();const controller=new AbortController();searchAbort.current=controller;setSearching(true);setPinError('');
    const identity=latest.current,origin=current;
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
      while(!controller.signal.aborted){
        const result=await workspaceApi.range<{match:Coordinate|null}>(artifact.id,{gridSearch:search.trim(),afterRow:cursor.row,afterCol:cursor.col,...(xlsx?{sheetId:sheet.id}:{})},controller.signal);
        assertRevision(artifact,result);
        const next=result.match;if(!next)break;
        const addressKey=key(next.row,next.col);if(seen.has(addressKey))break;seen.add(addressKey);
        const staged=entries.get(addressKey);
        if(!staged||fold(String(staged.operation.value??'')).includes(q)){hit=next;break;}
        cursor=next;
      }
      if(controller.signal.aborted||latest.current!==identity&&latest.current.selectedRange!==identity.selectedRange)return;
      const candidate=matchingDrafts[0];if(candidate&&(!hit||circular(candidate,hit)<0))hit=candidate;
      if(hit)move(hit.row,hit.col);else setPinError('一致するセルがありません。');
    }catch(e){if(!controller.signal.aborted)setPinError(e instanceof Error?e.message:'検索に失敗しました。')}
    finally{if(searchAbort.current===controller){searchAbort.current=null;setSearching(false)}}
  }
  const primary=<><span className="workspace-cell-address">{selectedRange}</span><span aria-hidden="true">ƒx</span><input ref={formulaInput} className="workspace-formula" aria-label="数式・セル値" value={ready?value(current.row,current.col):''} readOnly={!inputEnabled} onChange={e=>change(e.target.value)}/>{mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!ready||!inData} onClick={()=>void pin()}>セルを対象にする</button>}{mode==='edit'&&<>
      {xlsx&&<button type="button" className="btn btn-secondary btn-xs" aria-pressed={Boolean(styleEntry?.operation.bold??raw(current.row,current.col)?.bold)} disabled={!canStyle} onClick={toggleBold}>太字</button>}
    </>}</>;
  const secondary=mode==='edit'?<>
      <select aria-label="表の編集操作" disabled={!structuralEnabled||!!structural} value={editAction} onChange={e=>{setEditAction(e.target.value);setSheetName(e.target.value==='xlsx.rename_sheet'?sheet?.name??'':'')}}><option value="">表の操作…</option>{actions.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select>
      {needsName&&<input aria-label="シート名" value={sheetName} maxLength={31} onChange={e=>setSheetName(e.target.value)}/>}
      {editAction&&<button type="button" className="btn btn-secondary btn-xs" disabled={!structuralEnabled||!validName} onClick={stageStructure}>適用</button>}
    </>:null;
  const toolbar=<ResponsiveCommandBar primary={primary} secondary={secondary} minInlineWidth={850} closeOnButton/>;
  const tabs=<div className="workspace-toolbar" role="group" aria-label="シート">{sheets.map(s=><button key={s.id} type="button" className={'btn btn-secondary btn-xs '+(s.id===sheet?.id?'active':'')} aria-pressed={s.id===sheet?.id} onClick={()=>{setSheetId(s.id);move(0,0)}}>{s.name}</button>)}
    <input aria-label="セル範囲へ移動" placeholder="A1:B2" value={jump} onChange={e=>setJump(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();jumpToRange()}}}/><button type="button" className="btn btn-secondary btn-xs" disabled={!jump.trim()} onClick={jumpToRange}>移動</button>
    <input aria-label={xlsx?'シート全体を検索':'表全体を検索'} placeholder={xlsx?'シート全体を検索':'表全体を検索'} value={search} onChange={e=>{setSearch(e.target.value)}} onKeyDown={e=>{if(e.key==='Enter')void nextMatch()}}/><button type="button" className="btn btn-secondary btn-xs" disabled={!search.trim()||searching||!structure.ready} onClick={()=>void nextMatch()}>{searching?'検索中…':'次の一致'}</button></div>;
  return <UnifiedViewerZoomShell resetKey={artifact.id+':grid'} controlsTop={toolbar} controlsBottom={tabs}>
    {(structure.error||rangeError||pinError)&&<div role="alert" className="error-box">{structure.error||rangeError||pinError}<button type="button" onClick={()=>{structure.retry();setRetry(v=>v+1);setPinError('')}}>再試行</button></div>}
    {structural&&<div className="workspace-toolbar" role="status">{structural.label}（保存時に反映）<button type="button" className="btn btn-secondary btn-xs" disabled={editingLocked} onClick={()=>artifact.revision!==undefined&&onDraft(artifact.revision,null,'grid-structure')}>取消</button></div>}
    {!sheet?<div className="workspace-loading">{structure.error?'表を表示できません。':'読み込み中…'}</div>:<div className="workspace-virtual-grid" ref={scroll} role="grid" aria-label="表データ" aria-busy={loading} aria-rowcount={rowCount+1} aria-colcount={colCount+1} tabIndex={0} onScroll={updateViewport} onKeyDown={e=>{const delta:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};if(delta[e.key]){e.preventDefault();move(current.row+delta[e.key][0],current.col+delta[e.key][1],e.shiftKey)}else if(e.key==='Enter'&&mode==='edit'){e.preventDefault();formulaInput.current?.focus()}}}>
      <div className="workspace-grid-plane" style={{width:colAxis.plane,height:rowAxis.plane}}>
        <div role="row" className="workspace-grid-header" style={{height:CELL_HEIGHT}}><div role="columnheader" className="workspace-grid-corner" style={{width:HEADER}}/>{cols.map(c=><div key={colAxis.start+c.index} role="columnheader" className="workspace-grid-col" style={{left:c.start,width:c.size}}>{colName(colAxis.start+c.index)}</div>)}</div>
        {rows.map(r=>{const row=rowAxis.start+r.index;return <div key={row} role="row" aria-rowindex={row+2} className="workspace-grid-row" style={{top:r.start,height:r.size}}>
          <div role="rowheader" className="workspace-grid-rowhead" style={{width:HEADER}}>{row+1}</div>
          {cols.map(c=>{const col=colAxis.start+c.index,addr=address(row,col),cell=raw(row,col),pending=entries.has(key(row,col)),active=row>=bounds.row0&&row<=bounds.row1&&col>=bounds.col0&&col<=bounds.col1,preview=previews.get(addr),loaded=!!tile(row,col);return <div key={col} role="gridcell" aria-colindex={col+2} aria-selected={active} aria-label={addr} aria-busy={!loaded} onClick={e=>{move(row,col,e.shiftKey);scroll.current?.focus({preventScroll:true})}} title={preview!==undefined?'未保存の数式プレビュー':cell?.formulaStatus} data-formula-preview={preview!==undefined?'true':undefined} className={'workspace-grid-cell'+(pending?' pending':'')} style={{left:c.start,width:c.size,fontWeight:entries.get('style:'+key(row,col))?.operation.bold??cell?.bold?'bold':undefined}}>{preview??(pending?value(row,col):!loaded?'…':xlsx?String(cell?.value??''):original(row,col))}</div>})}
        </div>})}
      </div>
    </div>}
  </UnifiedViewerZoomShell>
}
