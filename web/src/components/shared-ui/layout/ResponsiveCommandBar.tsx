import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';

/** The primary controls retain usable width. Secondary controls move as a group
 * into an explicit disclosure on narrow workspaces (including split inspectors). */
export function ResponsiveCommandBar({primary,secondary,minInlineWidth=960,label='その他の編集操作'}:{primary:React.ReactNode;secondary?:React.ReactNode;minInlineWidth?:number;label?:string}){
  const root=useRef<HTMLDivElement>(null);
  const toggle=useRef<HTMLButtonElement>(null);
  const [compact,setCompact]=useState(true),[open,setOpen]=useState(false);
  useLayoutEffect(()=>{
    const el=root.current;if(!el)return;
    const measure=()=>setCompact(el.clientWidth<minInlineWidth);
    measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();
  },[minInlineWidth]);
  useEffect(()=>{if(!compact||!secondary)setOpen(false)},[compact,!!secondary]);
  const close=()=>{setOpen(false);toggle.current?.focus({preventScroll:true})};
  return <div ref={root} className={'workspace-commandbar'+(compact?' compact':'')} onKeyDown={e=>{if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();close()}}}>
    <div className="workspace-commandbar-row">
      <div className="workspace-toolbar workspace-commandbar-primary">{primary}</div>
      {compact&&secondary&&<button ref={toggle} type="button" className="btn btn-secondary btn-xs workspace-commandbar-toggle" aria-label={label} aria-expanded={open} onClick={()=>setOpen(v=>!v)}>…</button>}
      {!compact&&secondary&&<div className="workspace-toolbar workspace-commandbar-inline">{secondary}</div>}
    </div>
    {compact&&open&&secondary&&<div className="workspace-commandbar-panel" role="group" aria-label={label} onClick={e=>{const el=e.target as HTMLElement;if(el.closest('button')&&!el.closest('button')?.hasAttribute('data-keep-open'))setOpen(false)}} onChange={e=>{if(e.target instanceof HTMLSelectElement)setOpen(false)}}>{secondary}</div>}
  </div>;
}
