import React,{useLayoutEffect,useRef} from 'react';
import {Annotation,EditorState} from '@codemirror/state';
import {EditorView,keymap,lineNumbers,highlightActiveLine,highlightActiveLineGutter} from '@codemirror/view';
import {defaultKeymap,history,historyKeymap,indentWithTab} from '@codemirror/commands';
import {syntaxHighlighting,defaultHighlightStyle} from '@codemirror/language';
import {javascript} from '@codemirror/lang-javascript';
import {markdown} from '@codemirror/lang-markdown';
import {search,searchKeymap} from '@codemirror/search';
import {Compartment} from '@codemirror/state';

const externalUpdate=Annotation.define<boolean>();
export interface SourceEditorHandle {
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
    const lang=/^(md|markdown)$/i.test(language)?markdown():/^(js|jsx|ts|tsx|mjs|cjs)$/i.test(language)?javascript({typescript:/tsx?$/.test(language),jsx:/[jt]sx$/.test(language)}):[];
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
        instance.dispatch({changes:{from,to:old.length-end,insert:next.slice(from,next.length-end).replace(/\n/g,separator.current)},annotations:externalUpdate.of(true)});
      }
    }
  },[value,readOnly]);
  return <div ref={parent} className="workspace-cm"/>;
}
