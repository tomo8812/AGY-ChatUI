import React,{useEffect,useRef} from 'react';
import {useEditor,EditorContent,type Editor, type JSONContent} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {Extension,Mark} from '@tiptap/core';
import {Plugin} from '@tiptap/pm/state';
import {Fragment,Slice,type Node as ProseMirrorNode} from '@tiptap/pm/model';

export type WordMark='bold'|'italic'|'underline';
export type WordRun={text:string;originIndex?:number}&Partial<Record<WordMark,boolean>>;
const MARKS:WordMark[]=['bold','italic','underline'];
const WordOrigin=Mark.create({
  name:'wordOrigin',inclusive:true,keepOnSplit:true,
  addAttributes(){return {originIndex:{default:0}}},
  // Internal identity: never import a run index from pasted HTML.
  renderHTML(){return ['span',{},0]},
});
const SingleParagraph=Extension.create({
  name:'singleParagraph',priority:1000,
  addKeyboardShortcuts(){return {Enter:()=>this.editor.commands.setHardBreak()}},
  addProseMirrorPlugins(){return [new Plugin({filterTransaction:tr=>{
    return !tr.docChanged||tr.doc.childCount===1&&tr.doc.firstChild?.type.name==='paragraph';
  }})]},
});
function content(runs:WordRun[]):JSONContent {
  const nodes:JSONContent[]=[];
  for(const run of runs){
    const marks:NonNullable<JSONContent['marks']>=[{type:'wordOrigin',attrs:{originIndex:run.originIndex??0}},...MARKS.filter(m=>run[m]).map(type=>({type}))];
    run.text.split('\n').forEach((text,i)=>{if(i)nodes.push({type:'hardBreak',marks});if(text)nodes.push({type:'text',text,marks})});
  }
  return {type:'doc',content:[{type:'paragraph',content:nodes}]};
}
function read(editor:Editor):WordRun[]{
  const runs:WordRun[]=[];
  editor.state.doc.descendants(node=>{
    if(!node.isText&&node.type.name!=='hardBreak')return;
    const text=node.isText?node.text??'':'\n';
    const marks=Object.fromEntries(MARKS.map(m=>[m,node.marks.some(mark=>mark.type.name===m)])) as Record<WordMark,boolean>;
    const previous=runs.at(-1);
    const originIndex=Number(node.marks.find(mark=>mark.type.name==='wordOrigin')?.attrs.originIndex??previous?.originIndex??0);
    if(previous&&previous.originIndex===originIndex&&MARKS.every(m=>Boolean(previous[m])===marks[m]))previous.text+=text;
    else runs.push({text,originIndex,...marks});
  });
  return runs.length?runs:[{text:'',originIndex:0}];
}
interface Props {label:string;runs:WordRun[];readOnly:boolean;onChange:(runs:WordRun[])=>void;onFocus:(editor:Editor)=>void}
export function WordParagraphEditor({label,runs,readOnly,onChange,onFocus}:Props){
  const props=useRef({onChange,onFocus,readOnly});props.current={onChange,onFocus,readOnly};
  const incoming=JSON.stringify(content(runs));
  const editor=useEditor({
    extensions:[StarterKit.configure({heading:false,bulletList:false,orderedList:false,listItem:false,blockquote:false,code:false,codeBlock:false,horizontalRule:false,strike:false,link:false,gapcursor:false,dropcursor:false}),WordOrigin,SingleParagraph],
    content:JSON.parse(incoming),editable:!readOnly,immediatelyRender:false,
    editorProps:{
      attributes:{role:'textbox','aria-label':label,'aria-multiline':'true','class':'workspace-word-editor'},
      // Never paste foreign HTML, tables or object nodes into an existing run.
      handlePaste:(view,event)=>{
        const text=event.clipboardData?.getData('text/plain');
        if(text===undefined||props.current.readOnly)return false;
        event.preventDefault();
        const normalized=text.replace(/\r\n?/g,'\n');
        const nodes:ProseMirrorNode[]=[];
        const marks=view.state.storedMarks??view.state.selection.$from.marks();
        normalized.split('\n').forEach((line,i)=>{if(i)nodes.push(view.state.schema.nodes.hardBreak.create(null,null,marks));if(line)nodes.push(view.state.schema.text(line,marks))});
        if(nodes.length)view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes),0,0)));
        return true;
      },
      handleDrop:()=>true,
    },
    onFocus:({editor})=>props.current.onFocus(editor),
    onUpdate:({editor})=>{
      props.current.onChange(read(editor));
    },
  },[label]);
  useEffect(()=>{editor?.setEditable(!readOnly,false)},[editor,readOnly]);
  useEffect(()=>{
    if(editor&&JSON.stringify(content(read(editor)))!==incoming)editor.commands.setContent(JSON.parse(incoming),{emitUpdate:false});
  },[editor,incoming]);
  return <EditorContent editor={editor}/>;
}
