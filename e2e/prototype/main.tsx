import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../web/src/styles/index.css';
import 'katex/dist/katex.min.css';
import {ArtifactWorkspace} from '../../web/src/components/ArtifactWorkspace';
import {RichRenderer} from '../../web/src/components/shared-ui/RichRenderer';
import type {ArtifactRecord} from '../../web/src/types';
import type {RichDocumentV1} from '../../shared/rich-schema';

const actionLog:unknown[][]=[];
const recordAction=(kind:string,...args:unknown[])=>{actionLog.push([kind,...args])};
const catalogActions={
  openArtifact:(id:string)=>recordAction('artifact',id),
  saveArtifact:(filename:string,format:string,content:string)=>recordAction('save',filename,format,content),
  submitToChat:(text:string)=>recordAction('submit',text),
  startPinEdit:(id?:string)=>recordAction('pin',id),
};
const kind=new URLSearchParams(location.search).get('kind')??'markdown';
const formats:Record<string,{filename:string;previewKind:ArtifactRecord['previewKind'];mimeType:string}>={
  markdown:{filename:'notes.md',previewKind:'markdown',mimeType:'text/markdown'},
  code:{filename:'main.ts',previewKind:'code',mimeType:'text/plain'},
  csv:{filename:'sample.csv',previewKind:'table',mimeType:'text/csv'},
  xlsx:{filename:'sample.xlsx',previewKind:'table',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
  docx:{filename:'sample.docx',previewKind:'docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
  pptx:{filename:'sample.pptx',previewKind:'pptx',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'},
  pdf:{filename:'sample.pdf',previewKind:'pdf',mimeType:'application/pdf'}
};
const doc:RichDocumentV1={schemaVersion:1,title:'円形散水器の面積設計',state:{radius:2},computed:{area:'$state.radius * $state.radius * 3'},root:{id:'root',type:'stack',direction:'col',children:[
  {id:'radius',type:'slider',bind:'radius',label:'半径',min:1,max:8,step:1,unit:' m'},
  {id:'area',type:'kpi_card',label:'概算面積',value:{expr:'$computed.area'},unit:'m²'},
  {id:'diagram',type:'svg_scene',viewBox:'0 0 200 160',title:'散水範囲',elements:[
    {tag:'circle',id:'coverage',attrs:{cx:100,cy:80,r:{expr:'$state.radius * 8'},fill:'#c7e4fa',stroke:'#397ac4',strokeWidth:2}},
    {tag:'line',attrs:{x1:100,y1:80,x2:{expr:'100 + $state.radius * 8'},y2:80,stroke:'#397ac4'}},
  ]},
  {id:'chart',type:'chart',chartType:'bar',categories:['基準','現在'],series:[{key:'area',label:'面積',data:{expr:'[12, $computed.area]'}}]},
  {id:'reset',type:'button',label:'リセット',onClick:[{type:'reset_state'}]},
]}};
declare global { interface Window { __pr3aActionLog?:unknown[][]; __pr3aRichArtifacts?:ArtifactRecord[]; __pr3aFixtureRichDocument?: RichDocumentV1; __pr3aFixtureArtifact?: ArtifactRecord; __pr3aApplyArtifactUpdate?: (artifact:ArtifactRecord)=>void } }
function Harness(){
  const f=formats[kind]??formats.markdown;
  if(kind==='rich-catalog')window.__pr3aActionLog=actionLog;
  const [artifact,setArtifact]=useState<ArtifactRecord>(window.__pr3aFixtureArtifact??{id:'fixture',userId:'fixture-user',chatId:'fixture-chat',messageId:null,runId:null,relPath:f.filename,...f,sizeBytes:100,sha256:'a'.repeat(64),revision:1,source:'generated',diffPatch:null,createdAt:1,updatedAt:1});
  const [open,setOpen]=useState(true);
  // Only the test harness exposes revision replacement to exercise live updates.
  window.__pr3aApplyArtifactUpdate=setArtifact;
  return (kind==='rich'||kind==='rich-catalog')?<main style={{padding:16,maxWidth:950,margin:'0 auto'}}><RichRenderer document={window.__pr3aFixtureRichDocument??doc} userId="fixture-user" chatId="fixture-chat" artifacts={window.__pr3aRichArtifacts} actions={kind==='rich-catalog'?catalogActions:undefined}/></main>:open?<ArtifactWorkspace artifact={artifact} onArtifactChanged={setArtifact} onClose={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>開く</button>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
