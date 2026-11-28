import {afterEach,describe,expect,it,vi} from 'vitest';
import {RichStateStore} from '../../web/src/components/shared-ui/RichStateStore';
import {runExplicitRichActions,type RichActionHost} from '../../web/src/components/shared-ui/RichActionRunner';

const makeStore=()=>new RichStateStore({schemaVersion:1,state:{value:0},root:{id:'text',type:'text',content:{expr:'concat("", $state.value)'}}});
afterEach(()=>vi.unstubAllGlobals());
describe('Explicit rich actions',()=>{
  it('runs state actions and authorized explicit effects, not implicit state events',async()=>{
    const store=makeStore();
    const copy=vi.fn(async()=>{}),open=vi.fn(),save=vi.fn(),send=vi.fn(),pin=vi.fn();
    vi.stubGlobal('navigator',{clipboard:{writeText:copy}});
    vi.stubGlobal('window',{confirm:vi.fn(()=>true),open});
    const host:RichActionHost={authorizeArtifact:id=>id==='allowed',openArtifact:open,saveArtifact:save,submitToChat:send,startPinEdit:pin};
    await runExplicitRichActions([{type:'increment_state',key:'value',deltaExpr:'2'},{type:'copy_text',textExpr:'concat("Value ", $state.value)'},{type:'open_external_url',urlExpr:'"https://example.com/"'},{type:'open_artifact',artifactIdExpr:'"allowed"'},{type:'save_to_artifact',filenameExpr:'"notes.md"',format:'md',contentExpr:'"test"'},{type:'submit_to_chat',textExpr:'"test"'},{type:'start_pin_edit',targetNodeId:'text'}],store,store.context(),host);
    expect(copy).toHaveBeenCalledWith('Value 2');
    expect(open).toHaveBeenCalledWith('https://example.com/','_blank','noopener,noreferrer');
    expect(open).toHaveBeenCalledWith('allowed');
    expect(save).toHaveBeenCalledWith('notes.md','md','test');
    expect(send).toHaveBeenCalledWith('test');expect(pin).toHaveBeenCalledWith('text', { state: { value: 2 }, theme: 'light' });
  });
  it('cancels a chain when confirmation is denied',async()=>{
    const store=makeStore(),send=vi.fn(),save=vi.fn(),confirm=vi.fn(()=>false);
    vi.stubGlobal('window',{confirm});
    await runExplicitRichActions([{type:'save_to_artifact',filenameExpr:'"notes.md"',format:'md',contentExpr:'"text"'},{type:'submit_to_chat',textExpr:'"never"'},{type:'increment_state',key:'value'}],store,store.context(),{authorizeArtifact:()=>false,saveArtifact:save,submitToChat:send});
    expect(save).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(store.getStateValue('value')).toBe(0);
  });
  it('stops subsequent effects and state writes when an async action loses its lifetime',async()=>{
    const store=makeStore(),controller=new AbortController(),send=vi.fn();
    let complete!:()=>void;
    const copy=vi.fn(()=>new Promise<void>(resolve=>{complete=resolve}));
    vi.stubGlobal('navigator',{clipboard:{writeText:copy}});
    vi.stubGlobal('window',{confirm:vi.fn(()=>true)});
    const action=runExplicitRichActions([{type:'copy_text',textExpr:'"copy"'},{type:'submit_to_chat',textExpr:'"never"'},{type:'increment_state',key:'value'}],store,store.context(),{authorizeArtifact:()=>false,submitToChat:send},controller.signal);
    expect(copy).toHaveBeenCalledOnce();controller.abort();complete();await action;
    expect(send).not.toHaveBeenCalled();expect(store.getStateValue('value')).toBe(0);
  });
  it('rejects unsafe evaluated URL and unauthorized artifact before host execution',async()=>{
    const store=makeStore(),open=vi.fn();
    vi.stubGlobal('window',{confirm:vi.fn(()=>true),open});
    const host={authorizeArtifact:()=>false,openArtifact:open};
    await expect(runExplicitRichActions([{type:'open_external_url',urlExpr:'concat("java", "script:alert(1)")'}],store,store.context(),host)).rejects.toThrow();
    await expect(runExplicitRichActions([{type:'open_artifact',artifactIdExpr:'"foreign"'}],store,store.context(),host)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});
