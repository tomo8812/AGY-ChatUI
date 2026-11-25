import React,{useMemo,useRef,useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import {previewFormulas} from '../formulaPreview';
import { workspaceApi,supportsOperation } from '../../../api/workspace';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';
import { sha256Text } from '../targetHash';

type Sheet={id:string;name:string;part:string};
type Cell={address:string;value:unknown;type?:string;formula?:string;formulaStatus?:string;bold?:boolean};
type GridData={cells:Cell[];rows?:string[][];totalRows?:number;totalCols?:number;hasMore?:boolean};
const ROWS=50,COLS=20,CELL_WIDTH=112,CELL_HEIGHT=28,HEADER=44;
function colName(n:number){let s='';for(n++;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s}
function address(row:number,col:number){return colName(col)+(row+1)}
export function GridModule(props:WorkspaceModuleProps){
  const {artifact,mode,draft,capabilities,editingLocked,onDraft,onTarget}=props;
  const xlsx=/\.xlsx$/i.test(artifact.filename);
  const [sheetId,setSheetId]=useState('');
  const [page,setPage]=useState(0);
  const [colPage,setColPage]=useState(0);
  const [selected,setSelected]=useState({row:0,col:0});
  const [pinError,setPinError]=useState('');
  const [editAction,setEditAction]=useState('');
  const [sheetName,setSheetName]=useState('');
  const [search,setSearch]=useState('');
  const [searchAt,setSearchAt]=useState(-1);
  const formulaInput=useRef<HTMLInputElement>(null);
  const structure=useRevisionResource(artifact,'grid-structure',async signal=>{
    if(!xlsx)return {sheets:[{id:'csv',name:artifact.filename,part:''}]};
    const result=await workspaceApi.structure<{sheets:Sheet[]}>(artifact.id,signal);assertRevision(artifact,result);return result;
  });
  const sheets=structure.data?.sheets??[];
  const sheet=sheets.find(s=>s.id===sheetId)??sheets[0];
  const row0=page*ROWS,col0=colPage*COLS;
  const range=useRevisionResource<GridData>(artifact,'grid:'+String(sheet?.id)+':'+page+':'+colPage,async signal=>{
    if(!sheet)return {cells:[]};
    if(xlsx){
      const result=await workspaceApi.range<{cells:Cell[]}>(artifact.id,{sheetId:sheet.id,rangeA1:address(row0,col0)+':'+address(Math.min(1048575,row0+ROWS-1),Math.min(16383,col0+COLS-1))},signal);
      assertRevision(artifact,result);return result;
    }
    const result=await workspaceApi.range<{rows:string[][];totalRows?:number;totalCols?:number;hasMore?:boolean}>(artifact.id,{startRow:row0,endRow:row0+ROWS-1,startCol:col0,endCol:col0+COLS-1},signal);
    assertRevision(artifact,result);return {...result,cells:[]};
  });
  const ready=structure.ready&&range.ready&&!!sheet;
  const data=range.data;
  const cells=useMemo(()=>new Map(data?.cells.map(cell=>[cell.address,cell])),[data]);
  const raw=(r:number,c:number)=>xlsx?cells.get(address(r,c)):undefined;
  const key=(r:number,c:number)=>String(sheet?.id)+':'+address(r,c);
  function original(r:number,c:number){const cell=raw(r,c);return xlsx?cell?.formula?'='+cell.formula.replace(/^=/,''):String(cell?.value??''):String(data?.rows?.[r-row0]?.[c-col0]??'')}
  const entries=useMemo(()=>new Map(draft?.entries.map(e=>[e.key,e])),[draft]);
  function value(r:number,c:number){const e=entries.get(key(r,c));return e?.displayValue??String(e?.operation.value??original(r,c))}
  const structural=entries.get('grid-structure');
  const cellEditLocked=editingLocked||!!structural;
  function change(v:string){
    if(!ready||cellEditLocked||artifact.revision===undefined||!sheet)return;
    const {row,col}=selected;
    if(row<row0||row>=row0+ROWS||col<col0||col>=col0+COLS||!xlsx&&(row>(data?.totalRows??0)||col>(data?.totalCols??0)))return;
    const formula=xlsx&&v.startsWith('=');
    const op=xlsx?(formula?'xlsx.set_formula':'xlsx.set_cell'):'set_cell';
    if(!supportsOperation(capabilities,xlsx?op:'edit'))return;
    const k=key(row,col);
    onDraft(artifact.revision,v===original(row,col)?null:{key:k,displayValue:v,label:sheet.name+' '+address(row,col),operation:xlsx?{op,sheetPart:sheet.part,address:address(row,col),value:formula?v:(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)&&Number.isFinite(Number(v))?Number(v):v)}:{op,row,col,value:v}},k);
  }
  const scroll=useRef<HTMLDivElement>(null);
  const rowCount=Math.min(ROWS,1048576-row0),colCount=Math.min(COLS,16384-col0);
  const rows=useVirtualizer({count:rowCount,getScrollElement:()=>scroll.current,estimateSize:()=>CELL_HEIGHT,overscan:4,scrollMargin:CELL_HEIGHT});
  const cols=useVirtualizer({horizontal:true,count:colCount,getScrollElement:()=>scroll.current,estimateSize:()=>CELL_WIDTH,overscan:2,scrollMargin:HEADER});
  const previews=useMemo(()=>{
    if(!xlsx||!sheet||!data||!draft||!ready)return new Map<string,string>();
    const values=new Map(data.cells.map(c=>[c.address,{value:c.value,type:c.type,formula:c.formula}]));
    for(const e of draft.entries){
      const op=e.operation;
      if(op.sheetPart!==sheet.part||typeof op.address!=='string'||!['xlsx.set_formula','xlsx.set_cell'].includes(op.op))continue;
      const v=op.value;
      values.set(op.address,{value:v,type:typeof v==='number'?'n':'inlineStr',formula:op.op==='xlsx.set_formula'?String(v).replace(/^=/,''):undefined});
    }
    return previewFormulas(values,sheet.name,{row0,col0,rows:rowCount,cols:colCount});
  },[xlsx,sheet,data,draft,ready,row0,col0,rowCount,colCount]);
  function move(row:number,col:number){
    row=Math.max(0,Math.min(xlsx?1048575:Math.min(1048575,data?.totalRows??row0+ROWS-1),row));col=Math.max(0,Math.min(xlsx?16383:Math.min(16383,data?.totalCols??col0+COLS-1),col));
    setSelected({row,col});setPage(Math.floor(row/ROWS));setColPage(Math.floor(col/COLS));
    if(Math.floor(row/ROWS)===page&&Math.floor(col/COLS)===colPage){rows.scrollToIndex(row-row0,{align:'auto'});cols.scrollToIndex(col-col0,{align:'auto'})}else scroll.current?.scrollTo(0,0);
  }
  async function pin(){
    if(!ready||artifact.revision===undefined||!sheet)return;
    const {row,col}=selected;
    const cell=address(row,col),snippet=original(row,col);
    try{
      const selector=xlsx?{kind:'xlsx_range',sheetId:sheet.id,rangeA1:cell,expectedRangeValuesHash:artifact.sha256}:{kind:'csv_range',startRow:row,endRow:row,startCol:col,endCol:col,expectedRangeValuesHash:await sha256Text(JSON.stringify([data?.rows?.[row-row0]?.slice(col-col0,col-col0+1)??[]]))};
      onTarget({baseRevision:artifact.revision,label:sheet.name+' '+cell,selector,selectedContentSnapshot:snippet});
      setPinError('');
    }catch{setPinError('選択対象を識別できませんでした。')}
  }
  const inRange=selected.row>=row0&&selected.row<row0+ROWS&&selected.col>=col0&&selected.col<col0+COLS;
  const inData=xlsx||selected.row< (data?.totalRows??data?.rows?.length??0)&&selected.col<(data?.totalCols??COLS);
  const inputEnabled=ready&&inRange&&mode==='edit'&&!cellEditLocked;
  const structuralEnabled=ready&&inRange&&mode==='edit'&&!editingLocked&&(!draft||!!structural)&&artifact.revision!==undefined;
  const styleKey='style:'+key(selected.row,selected.col);
  const styleEntry=entries.get(styleKey);
  const canStyle=xlsx&&inputEnabled&&supportsOperation(capabilities,'xlsx.set_cell_style');
  function toggleBold(){if(!canStyle||!sheet||artifact.revision===undefined)return;const existing=raw(selected.row,selected.col)?.bold===true;const next=!(styleEntry?.operation.bold??existing);onDraft(artifact.revision,next===existing?null:{key:styleKey,label:address(selected.row,selected.col)+' 太字',operation:{op:'xlsx.set_cell_style',sheetPart:sheet.part,address:address(selected.row,selected.col),bold:next}},styleKey)}
  const actions=[{id:'insert_row',label:'行を挿入'},{id:'delete_row',label:'行を削除'},{id:'insert_col',label:'列を挿入'},{id:'delete_col',label:'列を削除'},...(xlsx?[{id:'xlsx.add_sheet',label:'シートを追加'},{id:'xlsx.rename_sheet',label:'シート名変更'},{id:'xlsx.remove_empty_sheet',label:'空のシートを削除'}]:[])].filter(action=>supportsOperation(capabilities,xlsx?(action.id.startsWith('xlsx.')?action.id:action.id.endsWith('row')?'xlsx.mutate_rows':'xlsx.mutate_columns'):'edit'));
  const needsName=['xlsx.add_sheet','xlsx.rename_sheet'].includes(editAction);
  const validName=!needsName||(sheetName.trim().length>0&&sheetName.trim().length<=31&&!/[\\[\\]:*?/\\\\]/.test(sheetName)&&!sheets.some(s=>s.name.toLowerCase()===sheetName.trim().toLowerCase()&&(editAction!=='xlsx.rename_sheet'||s.id!==sheet?.id)));
  function stageStructure(){
    if(!structuralEnabled||structural||!sheet||artifact.revision===undefined||!validName)return;
    const action=actions.find(a=>a.id===editAction);if(!action)return;
    const row=editAction.endsWith('row'),idx=row?selected.row:selected.col;
    if(!xlsx&&editAction.startsWith('delete')&&!inData)return;
    if(editAction.startsWith('delete')||editAction==='xlsx.remove_empty_sheet')if(!window.confirm(action.label+'しますか？'))return;
    const op=editAction.startsWith('xlsx.')?{op:editAction,sheetId:sheet.id,...(needsName?{name:sheetName.trim()}:{})}:xlsx?{op:row?'xlsx.mutate_rows':'xlsx.mutate_columns',sheetPart:sheet.part,index:idx+1,count:1,mode:editAction.startsWith('insert')?'insert':'delete'}:{op:editAction,index:idx,...(editAction==='insert_row'?{values:Array.from({length:Math.max(1,data?.totalCols??1)},()=> '')}:{})};
    onDraft(artifact.revision,{key:'grid-structure',label:action.label,operation:op},'grid-structure');setEditAction('');setSheetName('');
  }
  const searchMatches=useMemo(()=>{const q=search.trim().toLocaleLowerCase();if(!q||!data||!sheet)return [];const matches:{row:number;col:number}[]=[];for(let r=0;r<rowCount;r++)for(let col=0;col<colCount;col++){const rr=row0+r,cc=col0+col;if(value(rr,cc).toLocaleLowerCase().includes(q))matches.push({row:rr,col:cc})}return matches},[search,data,draft,row0,col0,sheet,rowCount,colCount]);
  function nextMatch(){if(!searchMatches.length)return;const n=(searchAt+1)%searchMatches.length;setSearchAt(n);const match=searchMatches[n];move(match.row,match.col)}
  const toolbar=<div className="workspace-toolbar"><span className="workspace-cell-address">{address(selected.row,selected.col)}</span><span aria-hidden="true">ƒx</span><input ref={formulaInput} className="workspace-formula" aria-label="数式・セル値" value={data&&inRange?value(selected.row,selected.col):''} readOnly={!inputEnabled} onChange={e=>change(e.target.value)}/>{mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!ready||!inRange||!inData} onClick={()=>void pin()}>セルを対象にする</button>}{mode==='edit'&&<>
      {xlsx&&<button type="button" className="btn btn-secondary btn-xs" aria-pressed={Boolean(styleEntry?.operation.bold??raw(selected.row,selected.col)?.bold)} disabled={!canStyle} onClick={toggleBold}>太字</button>}
      <select aria-label="表の編集操作" disabled={!structuralEnabled||!!structural} value={editAction} onChange={e=>{setEditAction(e.target.value);setSheetName(e.target.value==='xlsx.rename_sheet'?sheet?.name??'':'')}}><option value="">表の操作…</option>{actions.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select>
      {needsName&&<input aria-label="シート名" value={sheetName} maxLength={31} onChange={e=>setSheetName(e.target.value)}/>}
      {editAction&&<button type="button" className="btn btn-secondary btn-xs" disabled={!structuralEnabled||!validName} onClick={stageStructure}>適用</button>}
    </>}</div>;
  const tabs=<div className="workspace-toolbar" role="group" aria-label="シート">{sheets.map(s=><button key={s.id} type="button" className={'btn btn-secondary btn-xs '+(s.id===sheet?.id?'active':'')} aria-pressed={s.id===sheet?.id} onClick={()=>{setSheetId(s.id);move(0,0)}}>{s.name}</button>)}
    <input aria-label="表示範囲を検索" placeholder="範囲内検索" value={search} onChange={e=>{setSearch(e.target.value);setSearchAt(-1)}}/><button type="button" className="btn btn-secondary btn-xs" disabled={!searchMatches.length} onClick={nextMatch}>次の一致{search&&' ('+searchMatches.length+')'}</button>
    <button type="button" className="btn btn-secondary btn-xs" disabled={page===0} onClick={()=>move(Math.max(0,row0-ROWS),col0)}>前の行</button><button type="button" className="btn btn-secondary btn-xs" disabled={row0+ROWS>=1048576||(!xlsx&&row0+ROWS>(data?.totalRows??row0+ROWS-1))} onClick={()=>move(row0+ROWS,col0)}>次の行</button><button type="button" className="btn btn-secondary btn-xs" disabled={colPage===0} onClick={()=>move(row0,Math.max(0,col0-COLS))}>前の列</button><button type="button" className="btn btn-secondary btn-xs" disabled={col0+COLS>=16384||(!xlsx&&col0+COLS>(data?.totalCols??col0+COLS-1))} onClick={()=>move(row0,col0+COLS)}>次の列</button></div>;
  return <UnifiedViewerZoomShell resetKey={artifact.id+':grid'} controlsTop={toolbar} controlsBottom={tabs}>
    {(structure.error||range.error||pinError)&&<div role="alert" className="error-box">{structure.error||range.error||pinError}<button type="button" onClick={()=>{structure.retry();range.retry()}}>再試行</button></div>}
    {structural&&<div className="workspace-toolbar" role="status">{structural.label}（保存時に反映）<button type="button" className="btn btn-secondary btn-xs" disabled={editingLocked} onClick={()=>artifact.revision!==undefined&&onDraft(artifact.revision,null,'grid-structure')}>取消</button></div>}
    {range.loading&&data&&<p className="workspace-refresh muted-xs" role="status">最新の内容を読み込み中…</p>}
    {!data||!sheet?<div className="workspace-loading">{structure.error||range.error?'表を表示できません。':'読み込み中…'}</div>:<div className="workspace-virtual-grid" ref={scroll} role="grid" aria-label="表データ" aria-rowcount={rowCount+1} aria-colcount={colCount+1} tabIndex={0} onKeyDown={e=>{const delta:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};if(delta[e.key]){e.preventDefault();move(selected.row+delta[e.key][0],selected.col+delta[e.key][1])}else if(e.key==='Enter'&&mode==='edit'){e.preventDefault();formulaInput.current?.focus()}}}>
      <div className="workspace-grid-plane" style={{width:HEADER+cols.getTotalSize(),height:CELL_HEIGHT+rows.getTotalSize()}}>
        <div role="row" className="workspace-grid-header" style={{height:CELL_HEIGHT}}><div role="columnheader" className="workspace-grid-corner" style={{width:HEADER}}/>{cols.getVirtualItems().map(c=><div key={c.key} role="columnheader" className="workspace-grid-col" style={{left:c.start,width:c.size}}>{colName(col0+c.index)}</div>)}</div>
        {rows.getVirtualItems().map(r=><div key={r.key} role="row" aria-rowindex={r.index+2} className="workspace-grid-row" style={{top:r.start,height:r.size}}>
          <div role="rowheader" className="workspace-grid-rowhead" style={{width:HEADER}}>{row0+r.index+1}</div>
          {cols.getVirtualItems().map(c=>{const row=row0+r.index,col=col0+c.index,addr=address(row,col),cell=raw(row,col),pending=entries.has(key(row,col)),active=selected.row===row&&selected.col===col,preview=previews.get(addr);return <div key={c.key} role="gridcell" aria-colindex={c.index+2} aria-selected={active} aria-label={addr} onClick={()=>{setSelected({row,col});scroll.current?.focus({preventScroll:true})}} title={preview!==undefined?'未保存の数式プレビュー':cell?.formulaStatus} data-formula-preview={preview!==undefined?'true':undefined} className={'workspace-grid-cell'+(pending?' pending':'')} style={{left:c.start,width:c.size,fontWeight:entries.get('style:'+key(row,col))?.operation.bold??cell?.bold?'bold':undefined}}>{preview??(pending?value(row,col):xlsx?String(cell?.value??''):original(row,col))}</div>})}
        </div>)}
      </div>
    </div>}
  </UnifiedViewerZoomShell>
}
