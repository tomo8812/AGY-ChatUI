import React,{useState} from 'react';
import { workspaceApi,supportsOperation } from '../../../api/workspace';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';
import { sha256Text } from '../targetHash';

type Sheet={id:string;name:string;part:string};
type Cell={address:string;value:unknown;formula?:string;formulaStatus?:string};
type GridData={cells:Cell[];rows?:string[][];totalRows?:number;totalCols?:number;hasMore?:boolean};
const ROWS=25,COLS=10;
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
      const result=await workspaceApi.range<{cells:Cell[]}>(artifact.id,{sheetId:sheet.id,rangeA1:address(row0,col0)+':'+address(row0+ROWS-1,col0+COLS-1)},signal);
      assertRevision(artifact,result);return result;
    }
    const result=await workspaceApi.range<{rows:string[][];totalRows?:number;totalCols?:number;hasMore?:boolean}>(artifact.id,{startRow:row0,endRow:row0+ROWS-1,startCol:col0,endCol:col0+COLS-1},signal);
    assertRevision(artifact,result);return {...result,cells:[]};
  });
  const ready=structure.ready&&range.ready&&!!sheet;
  const data=range.data;
  const raw=(r:number,c:number)=>xlsx?data?.cells.find(cell=>cell.address===address(r,c)):undefined;
  const key=(r:number,c:number)=>String(sheet?.id)+':'+address(r,c);
  function original(r:number,c:number){const cell=raw(r,c);return xlsx?cell?.formula?'='+cell.formula.replace(/^=/,''):String(cell?.value??''):String(data?.rows?.[r-row0]?.[c-col0]??'')}
  function value(r:number,c:number){return String(draft?.entries.find(e=>e.key===key(r,c))?.operation.value??original(r,c))}
  function change(v:string){
    if(!ready||editingLocked||artifact.revision===undefined||!sheet)return;
    const {row,col}=selected;
    if(row<row0||row>=row0+ROWS||col<col0||col>=col0+COLS)return;
    const formula=xlsx&&v.startsWith('=');
    const op=xlsx?(formula?'xlsx.set_formula':'xlsx.set_cell'):'set_cell';
    if(!supportsOperation(capabilities,xlsx?op:'edit'))return;
    const k=key(row,col);
    onDraft(artifact.revision,v===original(row,col)?null:{key:k,label:sheet.name+' '+address(row,col),operation:xlsx?{op,sheetPart:sheet.part,address:address(row,col),value:formula?v:(v.trim()!==''&&Number.isFinite(Number(v))?Number(v):v)}:{op,row,col,value:v}},k);
  }
  function move(row:number,col:number){
    row=Math.max(0,Math.min(1048575,row));col=Math.max(0,Math.min(16383,col));
    setSelected({row,col});setPage(Math.floor(row/ROWS));setColPage(Math.floor(col/COLS));
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
  const inputEnabled=ready&&inRange&&mode==='edit'&&!editingLocked;
  const toolbar=<div className="workspace-toolbar"><span className="workspace-cell-address">{address(selected.row,selected.col)}</span><span aria-hidden="true">ƒx</span><input className="workspace-formula" aria-label="数式・セル値" value={data&&inRange?value(selected.row,selected.col):''} readOnly={!inputEnabled} onChange={e=>change(e.target.value)}/>{mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!ready||!inRange} onClick={()=>void pin()}>セルを対象にする</button>}</div>;
  const tabs=<div className="workspace-toolbar" role="group" aria-label="シート">{sheets.map(s=><button key={s.id} type="button" className={'btn btn-secondary btn-xs '+(s.id===sheet?.id?'active':'')} aria-pressed={s.id===sheet?.id} onClick={()=>{setSheetId(s.id);move(0,0)}}>{s.name}</button>)}
    <button type="button" className="btn btn-secondary btn-xs" disabled={page===0} onClick={()=>move(Math.max(0,row0-ROWS),col0)}>前の行</button><button type="button" className="btn btn-secondary btn-xs" disabled={row0+ROWS>=1048576||(!xlsx&&data?.hasMore===false)} onClick={()=>move(row0+ROWS,col0)}>次の行</button><button type="button" className="btn btn-secondary btn-xs" disabled={colPage===0} onClick={()=>move(row0,Math.max(0,col0-COLS))}>前の列</button><button type="button" className="btn btn-secondary btn-xs" disabled={col0+COLS>=16384} onClick={()=>move(row0,col0+COLS)}>次の列</button></div>;
  return <UnifiedViewerZoomShell resetKey={artifact.id+':grid'} controlsTop={toolbar} controlsBottom={tabs}>
    {(structure.error||range.error||pinError)&&<div role="alert" className="error-box">{structure.error||range.error||pinError}<button type="button" onClick={()=>{structure.retry();range.retry()}}>再試行</button></div>}
    {range.loading&&data&&<p className="workspace-refresh muted-xs" role="status">最新の内容を読み込み中…</p>}
    {!data||!sheet?<div className="workspace-loading">{structure.error||range.error?'表を表示できません。':'読み込み中…'}</div>:<table className="workspace-grid" role="grid" aria-label="表データ" tabIndex={0} onKeyDown={e=>{const delta:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};if(delta[e.key]){e.preventDefault();move(selected.row+delta[e.key][0],selected.col+delta[e.key][1])}}}><thead><tr><th> </th>{Array.from({length:COLS},(_,c)=><th key={c}>{colName(col0+c)}</th>)}</tr></thead><tbody>{Array.from({length:ROWS},(_,r)=><tr key={r}><th>{row0+r+1}</th>{Array.from({length:COLS},(_,c)=>{const row=row0+r,col=col0+c,cell=raw(row,col),pending=draft?.entries.some(e=>e.key===key(row,col)),active=selected.row===row&&selected.col===col;return <td key={c} role="gridcell" aria-selected={active} aria-label={address(row,col)} onClick={()=>setSelected({row,col})} title={cell?.formulaStatus} className={pending?'pending':''}>{pending?value(row,col):xlsx?String(cell?.value??''):original(row,col)}</td>})}</tr>)}</tbody></table>}
  </UnifiedViewerZoomShell>
}
