import type { RichAction, RichSideEffectAction, RichStateAction } from '../../../../shared/rich-schema';
import { createRichEvalBudget,evaluateRichExpr,isValidHttpUrl,validateSafeFilename, type RichEvalContext } from './RichExprEvaluator';
import type { RichStateStore } from './RichStateStore';

export interface RichActionHost {
  authorizeArtifact: (id:string)=>boolean;
  openArtifact?: (id:string)=>void|Promise<void>;
  saveArtifact?: (filename:string,format:Extract<RichSideEffectAction,{type:'save_to_artifact'}>['format'],content:string)=>void|Promise<void>;
  submitToChat?: (text:string)=>void|Promise<void>;
  startPinEdit?: (targetNodeId?:string)=>void|Promise<void>;
}
function isStateAction(action:RichAction):action is RichStateAction{
  return action.type==='set_state'||action.type==='toggle_state'||action.type==='increment_state'||action.type==='reset_state';
}
function boundedText(value:unknown,max:number):string{
  if(typeof value!=='string'||value.length>max)throw Error('操作内容が無効です。');
  return value;
}
/** Only explicit button/form/save handlers call this. Selection/input handlers use store.dispatch. */
export async function runExplicitRichActions(actions:readonly RichAction[],store:RichStateStore,local:RichEvalContext,host:RichActionHost,signal?:AbortSignal){
  // An async host operation must not authorize later actions after the block,
  // account, or chat has changed. A dismissed confirmation cancels the chain.
  const active=()=>!signal?.aborted;
  const budget=createRichEvalBudget();
  const current=()=>store.context(local.item,local.index,local.aliases);
  const val=(expr:string)=>evaluateRichExpr(expr,current(),budget);
  let pending:RichStateAction[]=[];
  const flush=()=>{if(pending.length){store.dispatch(pending,local);pending=[]}};
  for(const action of actions){
    if(!active())return;
    if(isStateAction(action)){pending.push(action);continue}
    flush();
    if(!active())return;
    switch(action.type){
      case 'copy_text': await navigator.clipboard.writeText(boundedText(val(action.textExpr),50000));break;
      case 'open_external_url': {
        const url=boundedText(val(action.urlExpr),2048);
        if(!isValidHttpUrl(url))throw Error('リンク先が無効です。');
        if(!window.confirm('次のリンクを開きますか？\n'+url)||!active())return;
        window.open(url,'_blank','noopener,noreferrer');
        break;
      }
      case 'open_artifact': {
        const id=boundedText(val(action.artifactIdExpr),200);
        if(!host.authorizeArtifact(id)||!host.openArtifact)throw Error('ファイルを開けません。');
        await host.openArtifact(id);break;
      }
      case 'save_to_artifact': {
        const filename=boundedText(val(action.filenameExpr),200),content=boundedText(val(action.contentExpr),512*1024);
        if(!validateSafeFilename(filename)||!['svg','md','txt','csv','json','code'].includes(action.format)||!host.saveArtifact)throw Error('保存できません。');
        if(!window.confirm(filename+' を保存しますか？')||!active())return;
        await host.saveArtifact(filename,action.format,content);
        break;
      }
      case 'submit_to_chat': {
        const message=boundedText(val(action.textExpr),50000);
        if(!message.trim()||!host.submitToChat)throw Error('メッセージを送信できません。');
        if(!window.confirm('この内容を送信しますか？\n'+message.slice(0,500))||!active())return;
        await host.submitToChat(message);
        break;
      }
      case 'start_pin_edit': if(!host.startPinEdit)throw Error('対象指定できません。');await host.startPinEdit(action.targetNodeId);break;
      default:throw Error('操作が無効です。');
    }
  }
  if(active())flush();
}
