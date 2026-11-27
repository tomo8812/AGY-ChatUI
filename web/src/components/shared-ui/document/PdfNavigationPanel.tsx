import React,{useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy,RenderTask} from 'pdfjs-dist';
type OutlineItem={title:string;page?:number;depth:number};
type SearchHit={page:number;excerpt:string};
import { pdfTextLayout } from '../../../../../server/src/artifacts/adapters/pdf-text-layout';

async function getPageTextLayout(doc:PDFDocumentProxy,pageNumber:number){
  const page=await doc.getPage(pageNumber);
  return pdfTextLayout((await page.getTextContent()).items,page.getViewport({scale:1}));
}
async function getPageText(doc:PDFDocumentProxy,pageNumber:number){
  return (await getPageTextLayout(doc,pageNumber)).text;
}
export interface PdfTextSelection {
  text:string;
  start:number;
  end:number;
}
async function getSelectedTextGeometry(doc:PDFDocumentProxy,pageNumber:number,expected:string,start:number,end:number):Promise<PdfTextSelection>{
  const layout=await getPageTextLayout(doc,pageNumber);
  if(layout.text!==expected)throw Error('ページ本文が変更されました。');
  return {text:expected.slice(start,end),start,end};
}

function Thumbnail({doc,page,onClick,active}:{doc:PDFDocumentProxy;page:number;onClick:()=>void;active:boolean}){
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    let cancelled=false,task:RenderTask|null=null;
    void (async()=>{try{
      const proxy=await doc.getPage(page);if(cancelled||!canvas.current)return;
      const natural=proxy.getViewport({scale:1});
      const viewport=proxy.getViewport({scale:Math.min(104/natural.width,120/natural.height,1)});
      const el=canvas.current;el.width=Math.ceil(viewport.width);el.height=Math.ceil(viewport.height);
      const ctx=el.getContext('2d');if(!ctx)return;
      task=proxy.render({canvas:el,canvasContext:ctx,viewport});await task.promise;
    }catch{}})();
    return()=>{cancelled=true;task?.cancel();if(canvas.current){canvas.current.width=0;canvas.current.height=0}};
  },[doc,page]);
  return <button className="pdf-nav-thumbnail" type="button" aria-label={'ページ '+page} aria-pressed={active} onClick={onClick}><canvas ref={canvas}/><span>{page}</span></button>;
}
export function PdfNavigationPanel({doc,page,onJump,onSelectText,onClose}:{doc:PDFDocumentProxy;page:number;onJump:(page:number)=>void;onSelectText?:(selection:PdfTextSelection,pageNumber:number)=>void;onClose:()=>void}){
  const [tab,setTab]=useState<'pages'|'outline'|'search'|'text'>('pages');
  const [jump,setJump]=useState(String(page));
  const [outline,setOutline]=useState<OutlineItem[]|null>(null);
  const [text,setText]=useState('');
  const [textLoading,setTextLoading]=useState(false);
  const [query,setQuery]=useState('');
  const [hits,setHits]=useState<SearchHit[]>([]);
  const [scan,setScan]=useState<{done:number;running:boolean;truncated:boolean;errors:number}>({done:0,running:false,truncated:false,errors:0});
  const [error,setError]=useState('');
  const task=useRef<AbortController|null>(null);
  const textBox=useRef<HTMLTextAreaElement>(null);
  const selectionGeneration=useRef(0);
  useEffect(()=>()=>{selectionGeneration.current++},[doc,page,tab,text,Boolean(onSelectText)]);
  const selectText=()=>{
    const field=textBox.current;
    if(!field||!onSelectText)return;
    const {selectionStart:start,selectionEnd:end}=field;
    const generation=++selectionGeneration.current;
    if(start===end){setError('本文の範囲を選択してください。');return}
    const current=()=>generation===selectionGeneration.current&&textBox.current===field&&
      field.selectionStart===start&&field.selectionEnd===end;
    void getSelectedTextGeometry(doc,page,text,start,end).then(result=>{
      if(current())onSelectText(result,page);
    },(error:unknown)=>{
      if(current())setError(error instanceof Error?error.message:'本文を選択できません。');
    });
  };
  useEffect(()=>setJump(String(page)),[page]);
  useEffect(()=>{
    setOutline(null);setHits([]);setText('');setScan({done:0,running:false,truncated:false,errors:0});setError('');
    return()=>task.current?.abort();
  },[doc]);
  useEffect(()=>{
    if(tab!=='outline'||outline!==null)return;
    let alive=true;
    void (async()=>{
      try{
        const tree=await doc.getOutline(),out:OutlineItem[]=[];
        async function walk(items:NonNullable<typeof tree>,depth:number){
          if(depth>12||!alive)return;
          for(const item of items){
            if(!alive||out.length>=300)return;
            let number:number|undefined;
            try{
              const dest=typeof item.dest==='string'?await doc.getDestination(item.dest):item.dest;
              const target=dest?.[0];
              if(typeof target==='number')number=target+1;
              else if(target&&typeof target==='object')number=await doc.getPageIndex(target)+1;
              if(number!==undefined&&(number<1||number>doc.numPages))number=undefined;
            }catch{}
            out.push({title:item.title,page:number,depth});
            if(item.items?.length)await walk(item.items,depth+1);
          }
        }
        if(tree)await walk(tree,0);
        if(alive)setOutline(out);
      }catch{if(alive){setOutline([]);setError('目次を取得できませんでした。')}}
    })();
    return()=>{alive=false};
  },[doc,tab,outline]);
  useEffect(()=>{
    if(tab!=='text')return;
    let alive=true;setText('');setTextLoading(true);setError('');
    void getPageText(doc,page).then(value=>{if(alive)setText(value)},()=>{if(alive)setError('本文を取得できませんでした。')}).finally(()=>{if(alive)setTextLoading(false)});
    return()=>{alive=false};
  },[doc,page,tab]);
  async function search(){
    const q=query.trim().toLocaleLowerCase();if(!q)return;
    task.current?.abort();const controller=new AbortController();task.current=controller;
    setHits([]);setError('');setScan({done:0,running:true,truncated:false,errors:0});
    let errors=0;const found:SearchHit[]=[];
    // Scan sequentially, without retaining the entire document in memory.
    // A bounded result list prevents huge documents from flooding the DOM.
    for(let p=1;p<=doc.numPages;p++){
      if(controller.signal.aborted)return;
      try{
        const value=await getPageText(doc,p);if(controller.signal.aborted)return;
        const i=value.toLocaleLowerCase().indexOf(q);
        if(i>=0)found.push({page:p,excerpt:value.slice(Math.max(0,i-42),i+q.length+60)});
      }catch{errors++}
      if(controller.signal.aborted)return;
      const truncated=found.length>=500&&p<doc.numPages;
      if(p%8===0||p===doc.numPages||truncated){setHits([...found]);setScan({done:p,running:p<doc.numPages&&!truncated,truncated,errors});}
      if(truncated)break;
    }
  }
  const first=Math.max(1,Math.min(page-2,doc.numPages-4));
  const numbers=Array.from({length:Math.min(5,doc.numPages)},(_,i)=>first+i);
  return <section className="pdf-navigation-panel" aria-label="PDFナビゲーション">
    <div className="pdf-panel-top"><form onSubmit={e=>{e.preventDefault();const n=Number(jump);if(Number.isInteger(n)&&n>=1&&n<=doc.numPages)onJump(n)}}><label>ページ <input type="number" aria-label="移動先ページ" value={jump} min={1} max={doc.numPages} onChange={e=>setJump(e.target.value)}/></label><button className="btn btn-secondary btn-xs" type="submit">移動</button></form><button className="btn btn-ghost btn-xs" type="button" onClick={onClose}>閉じる</button></div>
    <div className="pdf-panel-tabs" role="group" aria-label="PDF表示切替">{([['pages','ページ'],['outline','目次'],['search','検索'],['text','本文']] as const).map(([id,label])=><button key={id} type="button" className="btn btn-secondary btn-xs" aria-pressed={tab===id} onClick={()=>{setTab(id);setError('')}}>{label}</button>)}</div>
    {error&&<p role="alert" className="muted-xs">{error}</p>}
    {tab==='pages'&&<div className="pdf-thumbnail-list">{numbers.map(n=><Thumbnail key={n} doc={doc} page={n} active={page===n} onClick={()=>onJump(n)}/>)}</div>}
    {tab==='outline'&&<div className="pdf-panel-results">{outline===null?<p className="muted-xs">読み込み中…</p>:!outline.length?<p className="muted-xs">目次はありません。</p>:outline.map((item,i)=><button key={i} type="button" disabled={item.page===undefined} onClick={()=>item.page!==undefined&&onJump(item.page)} style={{paddingInlineStart:8+item.depth*10}}>{item.title}{item.page!==undefined&&' · '+item.page}</button>)}</div>}
    {tab==='search'&&<>
      <form className="pdf-panel-search" onSubmit={e=>{e.preventDefault();void search()}}><input type="search" aria-label="PDF全文検索" value={query} maxLength={200} onChange={e=>setQuery(e.target.value)}/><button type="submit" className="btn btn-secondary btn-xs" disabled={!query.trim()}>検索実行</button>{scan.running&&<button className="btn btn-ghost btn-xs" type="button" onClick={()=>{task.current?.abort();setScan(s=>({...s,running:false,truncated:true}))}}>停止</button>}</form>
      <p className="muted-xs" role="status">{scan.done} / {doc.numPages} ページ · {hits.length} 件{scan.truncated?'（途中まで）':''}{scan.errors?' · 読取不可 '+scan.errors+' ページ':''}</p>
      <div className="pdf-panel-results">{hits.map(hit=><button key={hit.page} type="button" onClick={()=>onJump(hit.page)}><strong>ページ {hit.page}</strong><span>{hit.excerpt}</span></button>)}</div>
    </>}
    {tab==='text'&&<><p className="muted-xs">ページ {page} の本文</p><textarea ref={textBox} aria-label="ページ本文" readOnly value={text} placeholder={textLoading?'読み込み中…':'テキストがありません。'} rows={6}/>{onSelectText&&<button className="btn btn-secondary btn-xs" type="button" disabled={!text} onClick={selectText}>選択本文を対象にする</button>}</>}
  </section>;
}
