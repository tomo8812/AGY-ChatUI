import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {Editor} from '@tiptap/react';
import {WordParagraphEditor,type WordRun,type WordMark} from '../../shared-ui/editor/WordParagraphEditor';
import { workspaceApi,supportsOperation,MAX_WORKSPACE_IMAGE_BYTES } from '../../../api/workspace';
import {ResponsiveCommandBar} from '../../shared-ui/layout/ResponsiveCommandBar';
import { UnifiedViewerZoomShell } from '../../UnifiedViewerZoomShell';
import { PdfCanvasViewer } from '../../shared-ui/document/PdfCanvasCore';
import { artifactVersionKey,buildArtifactContentUrl,ByteLruCache } from '../../../utils/viewerCache';
import { assertRevision,useRevisionResource } from '../useRevisionResource';
import type { WorkspaceModuleProps } from '../types';

interface WordBlock {
  blockIndex:number;
  type:string;
  text:string;
  editableText?:boolean;
  marks?:Partial<Record<WordMark,boolean>>;
  uiRuns?:WordRun[];
  headingLevel?:number;
  listed?:boolean;
  listType?:'bullet'|'decimal'|'lowerLetter'|'upperRoman';
  tableRows?:{text:string;editable:boolean}[][];
}

interface WordRange {
  blocks:WordBlock[];
  blockCount:number;
  hasMore:boolean;
  headings?:{blockIndex:number;text:string;level:number}[];
}

const CHUNK_SIZE=60;

interface WordChunkProps {
  index:number;
  count:number;
  blocks?:WordBlock[];
  onVisibility:(index:number,visible:boolean)=>void;
  renderBlock:(block:WordBlock)=>React.ReactNode;
}

function WordChunk({index,count,blocks,onVisibility,renderBlock}:WordChunkProps){
  const container=useRef<HTMLDivElement>(null);
  const content=useRef<HTMLDivElement>(null);
  const measured=useRef<number|undefined>(undefined);
  useEffect(()=>{
    const observer=new IntersectionObserver(([entry])=>onVisibility(index,entry.isIntersecting),{rootMargin:'320px 0px'});
    if(container.current)observer.observe(container.current);
    return()=>observer.disconnect();
  },[index,onVisibility]);
  React.useLayoutEffect(()=>{
    const el=content.current;
    if(!el)return;
    const measure=()=>{measured.current=el.offsetHeight};
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(el);
    return()=>observer.disconnect();
  },[Boolean(blocks)]);
  return <div ref={container} data-word-chunk={index}>
    {blocks?<div ref={content}>{blocks.map(renderBlock)}</div>:
      <div aria-hidden="true" style={{height:measured.current??count*42}}/>}
  </div>;
}

export function DocxModule({artifact,mode,capabilities,draft,editingLocked,onDraft,onTarget,target}:WorkspaceModuleProps){
  const [reading,setReading]=useState<'page'|'text'>('page');
  const pdfCap=capabilities?.operations.find(op=>op.operation==='export:pdf');
  const canRender=pdfCap?.availability==='supported'||pdfCap?.availability==='partial';
  const [outlineOpen,setOutlineOpen]=useState(false);
  const jumpBlock=useRef<number|null>(null);
  const canvas=useRef<HTMLElement>(null);
  const [selected,setSelected]=useState<number|null>(null);
  const activeEditor=useRef<Editor|null>(null);
  const imageInput=useRef<HTMLInputElement>(null);
  const revisionKey=artifactVersionKey(artifact);
  const latest=useRef({artifact,revisionKey,mode,selected});
  latest.current={artifact,revisionKey,mode,selected};
  const [imageError,setImageError]=useState('');
  const [imageTypes,setImageTypes]=useState<Record<string,string>>({});
  const nextAddition=useRef(0);
  const additionKey=(kind:string)=>kind+':'+artifact.revision+':'+(++nextAddition.current);
  const additions=(draft?.entries??[]).filter(e=>e.operation.op==='docx.add_paragraph'||e.operation.op==='docx.add_table');
  const [activeAddition,setActiveAddition]=useState<string|null>(null);

  const [visibleChunks,setVisibleChunks]=useState<ReadonlySet<number>>(()=>new Set([0]));
  const [loaded,setLoaded]=useState<{revisionKey:string;chunks:Map<number,WordBlock[]>}>({revisionKey,chunks:new Map()});
  const cache=useMemo(()=>new ByteLruCache<number,WordBlock[]>({
    maxEntries:6,maxBytes:4*1024*1024,sizeOf:blocks=>2*JSON.stringify(blocks).length,
  }),[revisionKey]);
  const requests=useRef(new Map<number,AbortController>());
  const resource=useRevisionResource(artifact,'docx:chunk0',async signal=>{
    const data=await workspaceApi.range<WordRange>(artifact.id,{start:0,count:CHUNK_SIZE},signal);
    assertRevision(artifact,data);
    return data;
  });
  const blockCount=resource.data?.blockCount??resource.data?.blocks.length??0;
  const totalChunks=Math.max(1,Math.ceil(blockCount/CHUNK_SIZE));
  const selectedChunk=selected===null?-1:Math.floor(selected/CHUNK_SIZE);
  const targetChunk=typeof target?.selector.blockIndex==='number'?Math.floor(target.selector.blockIndex/CHUNK_SIZE):-1;
  const retained=useMemo(()=>new Set([...visibleChunks,selectedChunk,targetChunk]),[visibleChunks,selectedChunk,targetChunk]);
  const displayed=(mode!=='view'||reading!=='page'||!canRender)&&!!resource.data;
  const activeChunks=loaded.revisionKey===revisionKey?loaded.chunks:undefined;
  const onVisibility=useCallback((index:number,visible:boolean)=>{
    setVisibleChunks(current=>{
      if(current.has(index)===visible)return current;
      const next=new Set(current);
      if(visible)next.add(index);else next.delete(index);
      return next;
    });
  },[]);

  useEffect(()=>{
    const current=requests.current;
    return()=>{for(const controller of current.values())controller.abort();current.clear()};
  },[revisionKey]);
  useEffect(()=>{
    const current=requests.current;
    for(const [index,controller] of current){
      if(!displayed||!retained.has(index)||index>=totalChunks){controller.abort();current.delete(index)}
    }
    setLoaded(previous=>{
      const chunks=new Map(previous.revisionKey===revisionKey?previous.chunks:undefined);
      for(const index of chunks.keys())if(!displayed||!retained.has(index)||index>=totalChunks)chunks.delete(index);
      return {revisionKey,chunks};
    });
    if(!displayed||!resource.ready)return;
    const currentArtifact=latest.current.artifact;
    for(const index of retained){
      if(index<=0||index>=totalChunks||current.has(index))continue;
      const publish=(blocks:WordBlock[])=>setLoaded(previous=>{
        const chunks=new Map(previous.revisionKey===revisionKey?previous.chunks:undefined);
        chunks.set(index,blocks);
        return {revisionKey,chunks};
      });
      const cached=cache.get(index);
      if(cached){publish(cached);continue}
      const controller=new AbortController();
      current.set(index,controller);
      void workspaceApi.range<WordRange>(currentArtifact.id,{start:index*CHUNK_SIZE,count:CHUNK_SIZE},controller.signal)
        .then(data=>{
          assertRevision(currentArtifact,data);
          if(controller.signal.aborted||latest.current.revisionKey!==revisionKey)return;
          cache.set(index,data.blocks);
          publish(data.blocks);
        }).catch(()=>{}).finally(()=>{
          if(current.get(index)===controller)current.delete(index);
        });
    }
  },[retained,totalChunks,revisionKey,resource.ready,displayed,cache]);

  const revealHeading=useCallback((index:number)=>{
    const element=canvas.current?.querySelector<HTMLElement>('[data-word-block="'+index+'"]');
    if(!element)return false;
    element.scrollIntoView({block:'nearest'});
    return true;
  },[]);

  useEffect(()=>{
    if(resource.ready&&jumpBlock.current!==null&&revealHeading(jumpBlock.current)){
      jumpBlock.current=null;
    }
  },[resource.ready,resource.data,activeChunks,revealHeading]);

  const selectedBlocks=selectedChunk===0?resource.data?.blocks:activeChunks?.get(selectedChunk);
  const block=selectedBlocks?.find(block=>block.blockIndex===selected);
  const locked=editingLocked||!resource.ready||artifact.revision===undefined;
  const can=(op:string)=>!locked&&supportsOperation(capabilities,op);
  const stage=(key:string,operation:Record<string,unknown>&{op:string},label:string)=>{
    if(artifact.revision!==undefined&&!locked)onDraft(artifact.revision,{key,label,operation},key);
  };
  const styleParagraph=(operation:Record<string,unknown>&{op:string},kind:string)=>{
    if(!block||block.type!=='p'||!can(operation.op))return;
    stage(kind+':'+block.blockIndex,{...operation,blockIndex:block.blockIndex},'段落 '+(block.blockIndex+1)+' の書式');
  };
  const editableSelection=Boolean(block?.editableText||additions.some(e=>e.key===activeAddition&&e.operation.op==='docx.add_paragraph'));

  async function pinParagraph(selectedBlock:WordBlock){
    if(artifact.revision===undefined||selectedBlock.type!=='p')return;
    const identity=artifact.revision;
    try{
      const result=await workspaceApi.range<{
        target:{
          fingerprint:string;
          paraId?:string;
          contextBeforeHash?:string;
          contextAfterHash?:string;
          occurrenceIndex?:number;
          duplicateCount?:number;
        }|null;
      }>(artifact.id,{targetBlockIndex:selectedBlock.blockIndex});
      assertRevision(artifact,result);
      if(latest.current.revisionKey!==revisionKey||latest.current.mode!=='pin'||latest.current.selected!==selectedBlock.blockIndex)return;
      if(!result.target)throw Error('段落を識別できません。');
      onTarget({
        baseRevision:identity,
        label:'段落 '+(selectedBlock.blockIndex+1),
        selector:{
          kind:'docx_paragraph',
          blockIndex:selectedBlock.blockIndex,
          ...(result.target.paraId?{paraId:result.target.paraId}:{}),
          expectedBlockHash:result.target.fingerprint,
          ...(result.target.contextBeforeHash?{contextBeforeHash:result.target.contextBeforeHash}:{}),
          ...(result.target.contextAfterHash?{contextAfterHash:result.target.contextAfterHash}:{}),
          ...(result.target.occurrenceIndex!==undefined?{occurrenceIndex:result.target.occurrenceIndex}:{}),
          ...(result.target.duplicateCount!==undefined?{duplicateCount:result.target.duplicateCount}:{}),
        },
        selectedContentSnapshot:selectedBlock.text.slice(0,50_000),
      });
    }catch(e){setImageError(e instanceof Error?e.message:'段落を識別できません。')}
  }

  const primary=<>
    {mode==='view'&&blockCount>0&&<span className="muted-xs">全 {blockCount} ブロック</span>}
    {mode==='edit'&&<>
      <button type="button" className="btn btn-secondary btn-xs" disabled={locked||!editableSelection} onMouseDown={e=>e.preventDefault()} onClick={()=>{const ed=activeEditor.current;if(ed&&!ed.isDestroyed&&ed.isEditable)ed.chain().focus().selectAll().run()}}>段落全選択</button>
      {([['bold','太字'],['italic','斜体'],['underline','下線']] as const).map(([mark,label])=><button key={mark} type="button" className="btn btn-secondary btn-xs" disabled={locked||!editableSelection} onMouseDown={e=>e.preventDefault()} onClick={()=>{const ed=activeEditor.current;if(ed&&!ed.isDestroyed&&ed.isEditable)ed.chain().focus().toggleMark(mark).run()}}>{label}</button>)}
    </>}
    {mode==='pin'&&<button type="button" className="btn btn-secondary btn-xs" disabled={!resource.ready||block?.type!=='p'||artifact.revision===undefined}
      onClick={()=>{if(block)void pinParagraph(block)}}>選択段落を対象にする</button>}
  </>;

  const outlineButton=<button type="button" className="btn btn-secondary btn-xs" aria-expanded={outlineOpen}
    onClick={()=>setOutlineOpen(open=>!open)}>見出し一覧</button>;
  const secondary=mode==='edit'?<>
    {outlineButton}
    <select aria-label="見出しレベル" disabled={!block?.editableText||!can('docx.set_paragraph_style')}
      value={String(draft?.entries.find(e=>e.key==='style:'+block?.blockIndex)?.operation.headingLevel??block?.headingLevel??0)}
      onChange={event=>styleParagraph({op:'docx.set_paragraph_style',headingLevel:Number(event.target.value)},'style')}>
      <option value="0">本文</option>
      {Array.from({length:9},(_,index)=><option key={index+1} value={index+1}>見出し {index+1}</option>)}
    </select>
    <select aria-label="リスト形式" disabled={!block?.editableText||!can('docx.set_list')}
      value={String(draft?.entries.find(e=>e.key==='list:'+block?.blockIndex)?.operation.listType??block?.listType??(block?.listed?'current':'none'))}
      onChange={event=>styleParagraph({op:'docx.set_list',listType:event.target.value},'list')}>
      <option value="current" disabled>既存のリスト</option>
      <option value="none">リストなし</option>
      <option value="bullet">箇条書き</option>
      <option value="decimal">番号付きリスト</option>
      <option value="lowerLetter">英小文字リスト</option>
      <option value="upperRoman">ローマ数字リスト</option>
    </select>
    <button type="button" className="btn btn-secondary btn-xs" disabled={!can('docx.add_paragraph')} onClick={()=>stage(additionKey('new-paragraph'),{op:'docx.add_paragraph',text:''},'段落を追加')}>段落を追加</button>
    <button type="button" className="btn btn-secondary btn-xs" disabled={!can('docx.add_table')} onClick={()=>stage(additionKey('new-table'),{op:'docx.add_table',rows:[['',''],['','']]},'表を追加')}>表を追加</button>
    <button type="button" className="btn btn-secondary btn-xs" disabled={!block?.editableText||!can('docx.add_image')} onClick={()=>imageInput.current?.click()}>画像を追加</button>
    <input ref={imageInput} type="file" hidden accept="image/png,image/jpeg" aria-label="画像ファイル" onChange={e=>{
      const file=e.target.files?.[0],index=block?.blockIndex,revision=artifact.revision;
      e.target.value='';
      if(!file||index===undefined||revision===undefined||!can('docx.add_image'))return;
      if(file.size>MAX_WORKSPACE_IMAGE_BYTES||!['image/png','image/jpeg'].includes(file.type)){setImageError('PNG/JPEG（6 MB以下）を選択してください。');return}
      const reader=new FileReader(),key=additionKey('image:'+index);
      reader.onload=()=>{
        if(latest.current.artifact.id!==artifact.id||latest.current.artifact.revision!==revision||typeof reader.result!=='string')return;
        const base64=reader.result.split(',')[1];
        if(base64){
          setImageTypes(types=>({...types,[key]:file.type}));
          onDraft(revision,{key,label:file.name,operation:{op:'docx.add_image',blockIndex:index,imageBase64:base64,widthPt:144}},key);
        }
      };reader.onerror=()=>setImageError('画像を読み込めませんでした。');reader.readAsDataURL(file);
    }}/>
  </>:null;

  const toolbar=<ResponsiveCommandBar primary={<>{primary}{mode!=='edit'&&outlineButton}</>} secondary={secondary} minInlineWidth={1050}/>;

  const outline=outlineOpen&&<nav className="workspace-source-outline" aria-label="文書の見出し">
    {resource.data?.headings?.length?resource.data.headings.map(heading=><button type="button" key={heading.blockIndex}
      style={{paddingInlineStart:heading.level*8}} onClick={()=>{
        setSelected(heading.blockIndex);setOutlineOpen(false);
        if(!revealHeading(heading.blockIndex)){
          jumpBlock.current=heading.blockIndex;
          const targetChunk=Math.floor(heading.blockIndex/CHUNK_SIZE);
          canvas.current?.querySelector<HTMLElement>('[data-word-chunk="'+targetChunk+'"]')?.scrollIntoView({block:'nearest'});
        }
      }}>{heading.text}</button>):<span className="muted-xs">見出しがありません。</span>}
  </nav>;

  if(mode==='view'&&reading==='page'&&canRender)return <div className="workspace-page-view">
    <div className="workspace-toolbar"><button className="btn btn-secondary btn-xs" type="button" onClick={()=>setReading('text')}>読取表示</button></div>
    <PdfCanvasViewer enhancedNavigation documentKey={artifact.id} url={buildArtifactContentUrl(artifact,{convertedPdf:true})}/>
  </div>;

  const renderBlock=(b:WordBlock)=>{
    const k='paragraph:'+b.blockIndex,entry=draft?.entries.find(e=>e.key===k);
    const original=b.uiRuns??[{text:b.text,originIndex:0,...b.marks}];
    const specs=entry?.operation.runs as WordRun[]|undefined;
    const runs=specs?.map(r=>({...original[r.originIndex??0],...r}))??original;
    const v=runs.map(r=>r.text).join('');
    const active=selected===b.blockIndex||target?.selector.blockIndex===b.blockIndex;
    const editable=mode==='edit'&&b.editableText===true&&supportsOperation(capabilities,'docx.set_paragraph_text');
    const headingLevel=Number(draft?.entries.find(e=>e.key==='style:'+b.blockIndex)?.operation.headingLevel??b.headingLevel??0);
    const listType=draft?.entries.find(e=>e.key==='list:'+b.blockIndex)?.operation.listType??b.listType;
    const list=listType?listType!=='none':b.listed;
    const listMarker=({decimal:'1.',lowerLetter:'a)',upperRoman:'I.'} as Record<string,string>)[String(listType)]??'•';
    const images=draft?.entries.filter(e=>e.operation.op==='docx.add_image'&&e.operation.blockIndex===b.blockIndex)??[];
    return <div
      key={b.blockIndex}
      data-word-block={b.blockIndex}
      data-list-marker={list?listMarker:undefined}
      style={headingLevel?{fontSize:Math.max(1,1.5-(headingLevel-1)*0.075)+'em'}:undefined}
      className={'workspace-word-block '+(active?'selected ':'')+(headingLevel?'word-heading ':'')+(list?'word-list':'')}
      onClick={()=>{if(selected!==b.blockIndex)activeEditor.current=null;setActiveAddition(null);setSelected(b.blockIndex)}}
    >
      {b.type==='p'?editable?<WordParagraphEditor label={'段落 '+(b.blockIndex+1)} runs={runs} readOnly={locked} onFocus={ed=>{activeEditor.current=ed;setActiveAddition(null);setSelected(b.blockIndex)}} onChange={next=>{
        if(artifact.revision===undefined||locked)return;
        const normalize=(list:WordRun[])=>list.map(r=>({text:r.text,originIndex:r.originIndex??0,bold:!!r.bold,italic:!!r.italic,underline:!!r.underline}));
        const same=JSON.stringify(normalize(next))===JSON.stringify(normalize(original));
        const specs=next.map(r=>{const originIndex=r.originIndex??0,base=original[originIndex]??original[0];const out:WordRun={text:r.text,originIndex};for(const m of ['bold','italic','underline'] as const)if(Boolean(r[m])!==Boolean(base[m]))out[m]=Boolean(r[m]);return out});
        onDraft(artifact.revision,same?null:{key:k,label:'段落 '+(b.blockIndex+1),operation:{op:'docx.set_paragraph_text',blockIndex:b.blockIndex,runs:specs,preserveRunProperties:true}},k);
      }}/>:<p>{v||'\u00a0'}{mode==='edit'&&b.editableText!==true&&<small className="workspace-protected">書式・埋め込み要素を保持</small>}</p>:b.tableRows?<table className="workspace-word-table"><tbody>{b.tableRows.map((row,r)=><tr key={r}>{row.map((cell,c)=>{
        const key='table-cell:'+b.blockIndex+':'+r+':'+c;
        const entry=draft?.entries.find(e=>e.key===key);
        const text=String(entry?.operation.text??cell.text);
        return <td key={c}>{mode==='edit'&&cell.editable&&supportsOperation(capabilities,'docx.set_table_cell')
          ?<textarea rows={Math.max(1,text.split('\n').length)} aria-label={'表 '+(b.blockIndex+1)+' '+(r+1)+'行 '+(c+1)+'列'}
            value={text} readOnly={locked} onChange={event=>{
              const value=event.target.value;
              if(locked||artifact.revision===undefined)return;
              if(value===cell.text){onDraft(artifact.revision,null,key);return}
              stage(key,{op:'docx.set_table_cell',blockIndex:b.blockIndex,row:r,column:c,text:value,preserveCellProperties:true},'表 '+(b.blockIndex+1)+' '+(r+1)+'行 '+(c+1)+'列');
            }}/>
          :<span>{text}</span>}</td>;
      })}</tr>)}</tbody></table>:<div className="workspace-protected">保護された文書要素 {b.text}</div>}
      {images.map(image=><figure className="workspace-word-image" key={image.key}>
        {imageTypes[image.key]&&<img alt={image.label} style={{width:Number(image.operation.widthPt??144)*4/3}}
          src={'data:'+imageTypes[image.key]+';base64,'+image.operation.imageBase64}/>}
        <figcaption><label>幅 <input type="number" aria-label={image.label+' の幅'} min={1} max={1000}
          value={Number(image.operation.widthPt??144)} disabled={locked} onChange={event=>{
            const widthPt=event.target.valueAsNumber;
            if(Number.isInteger(widthPt)&&widthPt>=1&&widthPt<=1000)stage(image.key,{...image.operation,widthPt},image.label);
          }}/></label>
          <button type="button" className="btn btn-ghost btn-xs" disabled={locked} onClick={()=>artifact.revision!==undefined&&onDraft(artifact.revision,null,image.key)}>取消</button></figcaption>
      </figure>)}
    </div>;
  };

  return <UnifiedViewerZoomShell resetKey={artifact.id+':docx'} controlsTop={<>{mode==='view'&&canRender&&<div className="workspace-toolbar"><button className="btn btn-secondary btn-xs" type="button" onClick={()=>setReading('page')}>ページ表示</button></div>}{toolbar}{outline}</>}>
    {imageError&&<p role="alert">{imageError}</p>}
    {resource.error&&<div className="error-box" role="alert">{resource.error}<button onClick={resource.retry}>再試行</button></div>}
    {resource.loading&&resource.data&&<p className="workspace-refresh muted-xs" role="status">最新の内容を読み込み中…</p>}
    {!resource.data?<div className="workspace-loading">{resource.error?'文書を表示できません。':'読み込み中…'}</div>:<article ref={canvas} className="workspace-word" aria-label="文書" data-continuous-canvas="true">
      {Array.from({length:totalChunks},(_,index)=><WordChunk
        key={index}
        index={index}
        count={Math.min(CHUNK_SIZE,Math.max(0,blockCount-index*CHUNK_SIZE))}
        blocks={totalChunks===1||retained.has(index)?(index===0?resource.data?.blocks:activeChunks?.get(index)):undefined}
        onVisibility={onVisibility}
        renderBlock={renderBlock}
      />)}
      {mode==='edit'&&additions.map((entry,index)=>{
        const cancel=()=>{if(artifact.revision!==undefined)onDraft(artifact.revision,null,entry.key);if(activeAddition===entry.key){activeEditor.current=null;setActiveAddition(null)}};
        if(entry.operation.op==='docx.add_paragraph')return <div key={entry.key}>
          <WordParagraphEditor label={index===0?'追加段落':'追加段落 '+(index+1)} runs={(entry.operation.runs as WordRun[]|undefined)??[{text:String(entry.operation.text??'')}]} readOnly={locked} onFocus={ed=>{activeEditor.current=ed;setActiveAddition(entry.key);setSelected(null)}} onChange={runs=>stage(entry.key,{op:'docx.add_paragraph',runs:runs.map(({originIndex,...r})=>r)},entry.label)}/>
          <button type="button" className="btn btn-ghost btn-xs" disabled={locked} onClick={cancel}>取消</button>
        </div>;
        const rows=entry.operation.rows as string[][],update=(next:string[][])=>stage(entry.key,{op:'docx.add_table',rows:next},entry.label);
        return <div key={entry.key} className="workspace-pptx-table"><table className="workspace-word-table"><tbody>{rows.map((row,r)=><tr key={r}>{row.map((cell,c)=><td key={c}><input aria-label={(index===0?'追加表':'追加表 '+(index+1))+' '+(r+1)+'行 '+(c+1)+'列'} value={cell} readOnly={locked} onChange={e=>update(rows.map((line,i)=>line.map((value,j)=>i===r&&j===c?e.target.value:value)))}/></td>)}</tr>)}</tbody></table>
          <button type="button" className="btn btn-secondary btn-xs" disabled={locked||rows.length>=100} onClick={()=>update([...rows,Array(rows[0].length).fill('')])}>行を追加</button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={locked||rows[0].length>=30} onClick={()=>update(rows.map(row=>[...row,'']))}>列を追加</button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={locked||rows.length<=1} onClick={()=>update(rows.slice(0,-1))}>末尾の行を削除</button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={locked||rows[0].length<=1} onClick={()=>update(rows.map(row=>row.slice(0,-1)))}>末尾の列を削除</button>
          <button type="button" className="btn btn-ghost btn-xs" disabled={locked} onClick={cancel}>取消</button>
        </div>;
      })}
    </article>}
  </UnifiedViewerZoomShell>;
}
