import React,{useLayoutEffect,useRef} from 'react';
import {Annotation,Compartment,EditorState,RangeSetBuilder,Transaction} from '@codemirror/state';
import {Decoration,type DecorationSet,EditorView,ViewPlugin,type ViewUpdate,keymap,lineNumbers,highlightActiveLine,highlightActiveLineGutter} from '@codemirror/view';
import {defaultKeymap,history,historyKeymap,indentWithTab} from '@codemirror/commands';
import {syntaxHighlighting,defaultHighlightStyle} from '@codemirror/language';
import {javascript} from '@codemirror/lang-javascript';
import {markdown} from '@codemirror/lang-markdown';
import {search,searchKeymap,SearchQuery,setSearchQuery,findNext} from '@codemirror/search';
import hljs from 'highlight.js';

const externalUpdate=Annotation.define<boolean>();

const HLJS_EXTENSION_MAP:Record<string,string>={
  py:'python',pyw:'python',pyi:'python',
  json:'json',jsonc:'json',json5:'json',
  yml:'yaml',yaml:'yaml',
  xml:'xml',xhtml:'xml',svg:'xml',plist:'xml',csproj:'xml',pom:'xml',
  html:'xml',htm:'xml',
  css:'css',scss:'scss',sass:'scss',less:'less',
  sql:'sql',
  sh:'bash',bash:'bash',zsh:'bash',ksh:'bash',
  rs:'rust',go:'go',java:'java',kt:'kotlin',kts:'kotlin',swift:'swift',
  c:'c',h:'c',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'cpp',hh:'cpp',hxx:'cpp',
  cs:'csharp',rb:'ruby',php:'php',pl:'perl',pm:'perl',lua:'lua',r:'r',
  scala:'scala',dart:'dart',ex:'elixir',exs:'elixir',erl:'erlang',hs:'haskell',
  toml:'ini',ini:'ini',cfg:'ini',conf:'ini',env:'ini',properties:'properties',
  dockerfile:'dockerfile',makefile:'makefile',mk:'makefile',cmake:'cmake',
  diff:'diff',patch:'diff',
  graphql:'graphql',gql:'graphql',proto:'protobuf',
  ps1:'powershell',psm1:'powershell',bat:'dos',cmd:'dos',
  tex:'latex',latex:'latex',nginx:'nginx',vim:'vim',
};

export function resolveHighlightLanguage(rawLanguage:string):string|null{
  const normalized=rawLanguage.trim().toLowerCase().replace(/^\./,'');
  if(!normalized||normalized==='text'||normalized==='txt'||normalized==='plain'||normalized==='plaintext')return null;
  const mapped=HLJS_EXTENSION_MAP[normalized]??normalized;
  return hljs.getLanguage(mapped)?mapped:null;
}

function decodeHtmlEntities(text:string):string{
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|#39|apos);/g,(_,token:string)=>{
    if(token==='amp')return '&';
    if(token==='lt')return '<';
    if(token==='gt')return '>';
    if(token==='quot')return '"';
    if(token==='#39'||token==='apos')return "'";
    if(token[0]==='#'){
      const code=token[1]==='x'||token[1]==='X'?parseInt(token.slice(2),16):Number(token.slice(1));
      return Number.isFinite(code)?String.fromCodePoint(code):_;
    }
    return _;
  });
}

const MAX_HLJS_SLICE_CHARS=200_000;
const HLJS_MARGIN_LINES=24;

function buildHljsDecorations(view:EditorView,hljsLang:string):DecorationSet{
  const builder=new RangeSetBuilder<Decoration>();
  const doc=view.state.doc;
  if(doc.length===0)return builder.finish();

  const visible=view.visibleRanges;
  if(visible.length===0)return builder.finish();

  // Merge overlapping/adjacent visible ranges with context margin
  const ranges:{from:number;to:number}[]=[];
  for(const range of visible){
    const startLine=Math.max(1,doc.lineAt(range.from).number-HLJS_MARGIN_LINES);
    const endLine=Math.min(doc.lines,doc.lineAt(range.to).number+HLJS_MARGIN_LINES);
    const from=doc.line(startLine).from;
    const to=doc.line(endLine).to;
    if(to-from>MAX_HLJS_SLICE_CHARS)continue;
    const prev=ranges[ranges.length-1];
    if(prev&&from<=prev.to){
      prev.to=Math.max(prev.to,to);
    }else{
      ranges.push({from,to});
    }
  }

  for(const {from,to} of ranges){
    const slice=doc.sliceString(from,to);
    if(!slice)continue;
    let html='';
    try{
      html=hljs.highlight(slice,{language:hljsLang,ignoreIllegals:true}).value;
    }catch{
      continue;
    }
    // Linear-time token walker mapping highlight.js <span class="..."> onto exact doc offsets
    const classStack:string[]=[];
    let offset=from;
    let pos=0;
    while(pos<html.length){
      const lt=html.indexOf('<',pos);
      if(lt===-1){
        const decoded=decodeHtmlEntities(html.slice(pos));
        if(decoded.length>0&&classStack.length>0){
          const end=Math.min(to,offset+decoded.length);
          if(end>offset)builder.add(offset,end,Decoration.mark({class:classStack.join(' ')}));
        }
        offset+=decoded.length;
        break;
      }
      if(lt>pos){
        const decoded=decodeHtmlEntities(html.slice(pos,lt));
        if(decoded.length>0&&classStack.length>0){
          const end=Math.min(to,offset+decoded.length);
          if(end>offset)builder.add(offset,end,Decoration.mark({class:classStack.join(' ')}));
        }
        offset+=decoded.length;
      }
      const gt=html.indexOf('>',lt);
      if(gt===-1)break;
      const tag=html.slice(lt+1,gt);
      if(tag.startsWith('/span')){
        classStack.pop();
      }else if(tag.startsWith('span')){
        const match=/class="([^"]+)"/.exec(tag);
        classStack.push(match?match[1]:'');
      }
      pos=gt+1;
    }
  }
  return builder.finish();
}

function createHljsExtension(hljsLang:string){
  return ViewPlugin.fromClass(
    class{
      decorations:DecorationSet;
      constructor(view:EditorView){
        this.decorations=buildHljsDecorations(view,hljsLang);
      }
      update(update:ViewUpdate){
        if(update.docChanged||update.viewportChanged){
          this.decorations=buildHljsDecorations(update.view,hljsLang);
        }
      }
    },
    {decorations:plugin=>plugin.decorations},
  );
}

export interface SourceEditorHandle {
  selectAll:()=>void;
  findNext:(query:string)=>boolean;
  getSelection:()=>{startLine:number;endLine:number};
  wrapSelection:(before:string,after:string)=>void;
}
interface Props {value:string;readOnly:boolean;language:string;onChange:(value:string)=>void;editorRef:React.RefObject<SourceEditorHandle|null>}
export function SourceEditor({value,readOnly,language,onChange,editorRef}:Props){
  const parent=useRef<HTMLDivElement>(null);
  const view=useRef<EditorView|null>(null);
  const ro=useRef(new Compartment());
  const callback=useRef(onChange);callback.current=onChange;
  // CodeMirror's default text model normalizes newlines. Preserve CRLF source
  // files with the original line-separator setting; avoid silently changing bytes.
  const separator=useRef(value.includes('\r\n')?'\r\n':'\n');
  useLayoutEffect(()=>{
    if(!parent.current)return;
    const isMarkdown=/^(md|markdown)$/i.test(language);
    const isJsTs=/^(js|jsx|ts|tsx|mjs|cjs)$/i.test(language);
    const hljsLang=!isMarkdown&&!isJsTs?resolveHighlightLanguage(language):null;
    const lang=isMarkdown
      ?markdown()
      :isJsTs
        ?javascript({typescript:/tsx?$/i.test(language),jsx:/[jt]sx$/i.test(language)})
        :hljsLang
          ?createHljsExtension(hljsLang)
          :[];
    const instance=new EditorView({parent:parent.current,state:EditorState.create({doc:value,extensions:[
      EditorState.lineSeparator.of(separator.current),lineNumbers(),highlightActiveLineGutter(),highlightActiveLine(),history(),search({top:true}),
      keymap.of([...searchKeymap,...defaultKeymap,...historyKeymap,indentWithTab]),syntaxHighlighting(defaultHighlightStyle,{fallback:true}),lang,
      EditorView.lineWrapping,EditorView.contentAttributes.of({'aria-label':'ソース','aria-multiline':'true',spellcheck:'false'}),
      ro.current.of([EditorState.readOnly.of(readOnly),EditorView.editable.of(true)]),
      EditorView.updateListener.of(update=>{
        if(update.docChanged&&!update.transactions.some(tr=>tr.annotation(externalUpdate)))callback.current(update.state.sliceDoc());
      }),
    ]})});
    view.current=instance;
    editorRef.current={
      findNext:query=>{if(!query)return false;instance.dispatch({effects:setSearchQuery.of(new SearchQuery({search:query,literal:true}))});instance.focus();return findNext(instance)},
      selectAll:()=>{instance.focus();instance.dispatch({selection:{anchor:0,head:instance.state.doc.length},scrollIntoView:true})},
      getSelection:()=>{
        const {from,to}=instance.state.selection.main;
        return {startLine:instance.state.doc.lineAt(from).number,endLine:instance.state.doc.lineAt(Math.max(from,to-1)).number};
      },
      wrapSelection:(before,after)=>{
        if(instance.state.readOnly)return;
        const {from,to}=instance.state.selection.main;
        const insert=before+instance.state.sliceDoc(from,to)+after;
        instance.dispatch({changes:{from,to,insert},selection:{anchor:from+before.length,head:to+before.length}});
        instance.focus();
      }
    };
    return()=>{editorRef.current=null;view.current=null;instance.destroy()};
  },[language,editorRef]);
  useLayoutEffect(()=>{
    const instance=view.current;
    if(!instance)return;
    if(instance.state.readOnly!==readOnly)instance.dispatch({effects:ro.current.reconfigure([EditorState.readOnly.of(readOnly),EditorView.editable.of(true)])});
    if(instance.state.sliceDoc()!==value){
      // Update only the changed interval so that the mapped caret/selection and
      // scroll remain stable across save acknowledgements or live refresh.
      const old=instance.state.doc.toString(),next=value.replace(/\r\n/g,'\n');
      if(old!==next){
        let from=0,end=0;
        while(from<old.length&&from<next.length&&old[from]===next[from])from++;
        while(end<old.length-from&&end<next.length-from&&old[old.length-1-end]===next[next.length-1-end])end++;
        instance.dispatch({changes:{from,to:old.length-end,insert:next.slice(from,next.length-end).replace(/\n/g,separator.current)},annotations:[externalUpdate.of(true),Transaction.addToHistory.of(false)]});
      }
    }
  },[value,readOnly]);
  return <div ref={parent} className="workspace-cm hljs" data-syntax-language={language}/>;
}
