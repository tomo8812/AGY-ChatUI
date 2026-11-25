import {expect,test,type Page,type TestInfo} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createTestServer,TestApiClient} from '../server/tests/helpers/test-harness.js';
import type {ArtifactRecord} from '../web/src/types';

const runtime=process.env.AGY_PR3A_RUNTIME_DIR;
const fixtureDir=process.env.AGY_PR3A_FIXTURE_DIR;
if(process.env.CI&&(!runtime||!fixtureDir))throw Error('PR3A real browser fixtures are required in CI');
const targets=[{width:1280,height:720,project:'pc-chromium'},{width:1440,height:900,project:'pc-chromium'},{width:1920,height:1080,project:'pc-chromium'},{width:375,height:812,project:'iphone-webkit'},{width:430,height:932,project:'iphone-webkit'}];
const base='http://127.0.0.1:4174/';
const cases=[
  {kind:'markdown',filename:'notes.md',updated:'# Updated notes\n\nNew text\n'},
  {kind:'code',filename:'main.ts',updated:'export const updated = 42;\n'},
  {kind:'xlsx',filename:'sample.xlsx',updated:'42'},
  {kind:'csv',filename:'sample.csv',updated:'Updated item'},
  {kind:'docx',filename:'sample.docx',updated:'Updated paragraph'},
  {kind:'pptx',filename:'sample.pptx',updated:'Updated title'},
  {kind:'pdf',filename:'sample.pdf',updated:''},
] as const;

async function openCommand(page:Page,control:ReturnType<Page['getByRole']>){
  if(!await control.isVisible())await page.getByRole('button',{name:'その他の編集操作',exact:true}).click();
  await expect(control).toBeVisible();
}
async function readySlide(page:Page){
  const scene=page.locator('[data-slide-canvas="true"]');
  await expect(scene).toBeVisible({timeout:60000});
  await expect.poll(async()=>scene.locator('img').evaluateAll(images=>images.length>0&&images.every(img=>(img as HTMLImageElement).complete&&(img as HTMLImageElement).naturalWidth>0)),{timeout:60000}).toBe(true);
  return scene;
}
function comparePng(actual:string,expected:string){
  const script='import sys,json; from PIL import Image; sys.path.insert(0,"server/scripts"); from artifact_doc_worker import compute_image_ssim_and_mae; a=Image.open(sys.argv[1]).convert("RGB"); b=Image.open(sys.argv[2]).convert("RGB").resize(a.size,Image.Resampling.LANCZOS); s,m=compute_image_ssim_and_mae(a,b); print(json.dumps({"ssim":s,"mae":m,"width":a.width,"height":a.height}))';
  return JSON.parse(execFileSync(path.join(runtime!,'venv/bin/python3'),['-c',script,actual,expected],{encoding:'utf8'})) as {ssim:number;mae:number;width:number;height:number};
}
async function capturePptx(page:Page,info:TestInfo,reference:Buffer,name:string){
  const scene=await readySlide(page);
  // Wait for all transparent shape layers rather than comparing a background-only intermediate.
  await expect(scene.locator('img')).toHaveCount(3,{timeout:60000});
  await expect.poll(async()=>scene.locator('img').evaluateAll(imgs=>imgs.every(img=>(img as HTMLImageElement).complete&&(img as HTMLImageElement).naturalWidth>0)),{timeout:60000}).toBe(true);
  await expect.poll(()=>scene.evaluate(el=>{
    const viewport=el.closest('.workspace-pptx-scroll');
    if(!viewport)return false;
    const a=el.getBoundingClientRect(),b=viewport.getBoundingClientRect();
    return a.top>=b.top-2&&a.bottom<=b.bottom+2&&a.left>=b.left-2&&a.right<=b.right+2;
  }),{timeout:10000}).toBe(true);
  const actual=info.outputPath(name+'-canvas.png'),expected=info.outputPath(name+'-reference.png');
  fs.writeFileSync(expected,reference);
  // The active selection outline is chrome, not document pixels. Temporarily hide
  // hit targets in this capture only; the canvas images remain the actual DOM output.
  const style=await page.addStyleTag({content:'.workspace-shape-hit{visibility:hidden!important}'});
  try{await scene.screenshot({path:actual,scale:'css'});}finally{await style.evaluate(el=>el.remove())}
  const result=comparePng(actual,expected);
  expect(result.ssim,'Browser layer composite vs formal LibreOffice PNG').toBeGreaterThanOrEqual(.95);
  expect(result.mae,'Browser layer mean absolute error').toBeLessThanOrEqual(5);
  return result;
}

for(const vp of targets){
  test('PR3A actual files and persistent edits '+vp.width+'x'+vp.height,async({page},info)=>{
    test.skip(info.project.name!==vp.project||!runtime||!fixtureDir);
    test.setTimeout(600000);
    const srv=await createTestServer({docRuntimeDir:runtime!,installDocRuntime:'compact',sandboxMode:'off',allowUnsandboxedDocWorkers:true,docWorkerBudget:2});
    const evidence:unknown[]=[];
    const failures:string[]=[];
    try{
      const client=new TestApiClient(srv.baseUrl);
      const reg=await client.request<{user:{id:string}}>('POST','/api/auth/register',{username:'pr3a-real',displayName:'PR3A Real',password:'password123'});
      expect(reg.status).toBe(201);
      const userId=reg.data.user.id,chatId='pr3a-real-chat';
      const dir=fs.mkdtempSync(path.join(srv.dataRoot,'browser-workspace-'));
      srv.ctx.db.createChat({id:chatId,userId,projectId:null,title:'PR3A Real Files',workspaceDir:dir,modelId:'',effortValue:'',projectContextVersion:0});
      const svc=srv.ctx.artifactService;
      await page.setViewportSize({width:vp.width,height:vp.height});
      await page.route(url=>url.origin==='http://127.0.0.1:4174'&&url.pathname.startsWith('/api/'),async route=>{
        const request=route.request(),url=new URL(request.url());
        // Transport actual authenticated requests to the isolated Fastify server.
        // No API payload or response is mocked; test authentication is scoped to this server.
        const response=await route.fetch({url:srv.baseUrl+url.pathname+url.search,headers:{
          ...request.headers(),cookie:client.cookieHeader,
          ...(client.csrfToken?{'x-csrf-token':decodeURIComponent(client.csrfToken)}:{})
        },timeout:90000});
        await route.fulfill({response});
      });
      const artifacts:Record<string,Awaited<ReturnType<typeof svc.createArtifact>>['artifact']>={};
      for(const item of cases){
        artifacts[item.kind]=(await svc.createArtifact({userId,scopeKind:'chat',chatId,relPath:item.filename,content:fs.readFileSync(path.join(fixtureDir!,item.filename)),actorKind:'user',actorId:userId})).artifact;
      }
      await page.addInitScript(records=>{
        const kind=new URLSearchParams(location.search).get('kind')??'';
        (window as Window&{__pr3aFixtureArtifact?:unknown}).__pr3aFixtureArtifact=records[kind];
      },artifacts);
      for(const item of cases){
        try{await test.step(item.kind,async()=>{
          const artifact=artifacts[item.kind];
          await page.goto(base+'?kind='+item.kind);
          await expect(page.getByRole('dialog',{name:item.filename})).toBeVisible({timeout:30000});
          const record:Record<string,unknown>={kind:item.kind,artifactId:artifact.id,beforeRevision:artifact.revision};
          if(item.kind==='pdf'){
            await expect(page.locator('canvas').first()).toBeVisible({timeout:30000});
            await page.getByRole('button',{name:'ナビゲーション',exact:true}).click();
            await page.getByRole('button',{name:'検索',exact:true}).click();
            await page.getByRole('searchbox',{name:'PDF全文検索'}).fill('Wide second page');
            await page.getByRole('button',{name:'検索実行'}).click();
            await page.getByRole('button',{name:/ページ 2 Wide second page/}).click();
            await expect(page.locator('.pdf-page-indicator')).toContainText('2 / 2');
            await page.getByRole('button',{name:'本文',exact:true}).click();
            await expect(page.getByRole('textbox',{name:'ページ本文'})).toHaveValue('Wide second page');
            await page.locator('.pdf-navigation-panel').getByRole('button',{name:'閉じる',exact:true}).click();
            await expect(page.locator('.pdf-page-indicator')).toContainText('2 / 2');
            const secondPageVisible=()=>page.locator('.pdf-page-slot[data-page-number="2"]').evaluate(el=>{
              const a=el.getBoundingClientRect(),b=el.closest('.pdf-canvas-scroll')!.getBoundingClientRect();
              return Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>Math.min(a.height,b.height)*0.4;
            });
            await expect.poll(secondPageVisible).toBe(true);
            await page.getByRole('button',{name:'拡大',exact:true}).click();
            const scale=await page.locator('[data-viewer-zoom-surface]').getAttribute('data-zoom-scale');
            await page.getByRole('button',{name:'依頼',exact:true}).click();
            await expect(page.locator('.pdf-page-indicator')).toContainText('2 / 2');
            await expect.poll(secondPageVisible).toBe(true);
            await page.getByRole('button',{name:'ページを対象にする'}).click();
            await expect(page.locator('.workspace-selection')).toContainText('ページ 2');
            record.page=2;record.zoom=scale;
          }else{
            if(item.kind==='markdown'){
              await page.getByRole('button',{name:'目次',exact:true}).click();
              await page.getByRole('navigation',{name:'文書目次'}).getByRole('button',{name:'Notes',exact:true}).click();
              await page.getByRole('textbox',{name:'検索',exact:true}).fill('Original text');
              await page.getByRole('button',{name:'次の一致',exact:true}).click();
              await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toBe('Original text');
              await page.getByRole('textbox',{name:'検索',exact:true}).fill('');
            }
            await page.getByRole('button',{name:'編集',exact:true}).click({timeout:30000});
            if(item.kind==='markdown'||item.kind==='code'){
              const editor=page.getByRole('textbox',{name:'ソース'});
              await expect(editor).toBeEditable({timeout:30000});
              await editor.focus();await page.getByRole('button',{name:'全選択',exact:true}).click();await page.keyboard.insertText(item.updated);
              await expect.poll(()=>page.locator('.cm-line').allTextContents()).toEqual(item.updated.split('\n'));
            }else if(item.kind==='xlsx'||item.kind==='csv'){
              await page.getByRole('gridcell',{name:'A1',exact:true}).click({timeout:30000});
              await page.getByRole('textbox',{name:'数式・セル値'}).fill(item.updated);
              if(item.kind==='xlsx'){
                await expect(page.getByRole('gridcell',{name:'B1',exact:true})).toHaveText('84');
                await page.getByRole('button',{name:'太字',exact:true}).click();
                await expect(page.getByRole('button',{name:'太字',exact:true})).toHaveAttribute('aria-pressed','true');
              }
            }else if(item.kind==='docx'){
              const word=page.getByRole('textbox',{name:'段落 1',exact:true});
              await word.fill(item.updated,{timeout:30000});
              await page.getByRole('button',{name:'段落全選択',exact:true}).click();
              await page.getByRole('button',{name:'太字',exact:true}).click();
              await expect(word.locator('strong')).toHaveText(item.updated);
              const mixed=page.getByRole('textbox',{name:'段落 2',exact:true});
              await mixed.click();
              await page.getByRole('button',{name:'段落全選択',exact:true}).click();
              await page.getByRole('button',{name:'下線',exact:true}).click();
              await expect(mixed.locator('strong')).toHaveText('Keep ');
              await expect(mixed.locator('em')).toHaveText('formatting');
              await expect(page.getByText('書式・埋め込み要素を保持')).toBeVisible();
            }else{
              const invalid=await client.request('POST','/api/files/'+artifact.id+'/render-draft-slide',{expectedRevision:1,pageIndex:0,operation:{op:'replace_source',content:'invalid'}});
              expect(invalid.status).toBe(400);
              const stale=await client.request('POST','/api/files/'+artifact.id+'/render-draft-slide',{expectedRevision:999,pageIndex:0,operation:{op:'pptx.add_shape',slidePart:'ppt/slides/slide1.xml',kind:'rectangle',text:'Never saved',boundsPt:[10,10,100,50]}});
              expect(stale.status).toBe(409);
              expect(srv.ctx.db.getArtifact(userId,artifact.id)?.revision).toBe(1);
              const before=await svc.renderPng(userId,artifact.id,{pageIndex:0});
              record.beforeVisual=await capturePptx(page,info,before.png,'pptx-before');
              await page.getByRole('button',{name:'Title',exact:true}).click();
              const textInput=page.getByRole('textbox',{name:'図形テキスト'});
              await textInput.fill(item.updated);
              expect((await textInput.boundingBox())!.width).toBeGreaterThanOrEqual(90);
              const handle=page.getByRole('button',{name:'選択要素をリサイズ',exact:true});
              await expect(handle).toBeVisible();
              await handle.press('ArrowRight');
              await openCommand(page,page.getByRole('button',{name:'太字',exact:true}));
              await page.getByRole('button',{name:'太字',exact:true}).click();
              // Await actual worker output for the unsaved text; no document mutation yet.
              await expect(page.locator('[data-slide-canvas]')).toHaveAttribute('data-preview-ready','true',{timeout:90000});
              expect(srv.ctx.db.getArtifact(userId,artifact.id)?.revision).toBe(1);
              await expect.poll(()=>page.locator('[data-slide-canvas] img').evaluateAll(imgs=>imgs.length===3&&imgs.every(img=>(img as HTMLImageElement).complete&&(img as HTMLImageElement).naturalWidth>0))).toBe(true);
              const style=await page.addStyleTag({content:'.workspace-shape-hit{visibility:hidden!important}'});
              try{await page.locator('[data-slide-canvas]').screenshot({path:info.outputPath('pptx-draft-canvas.png'),scale:'css'});}finally{await style.evaluate(el=>el.remove())}
            }
            await expect(page.getByRole('button',{name:'保存',exact:true})).toBeEnabled();
            await page.getByRole('button',{name:'拡大',exact:true}).click();
            const zoom=await page.locator('[data-viewer-zoom-surface]').getAttribute('data-zoom-scale');
            await page.screenshot({path:info.outputPath('real-'+item.kind+'-editing.png')});
            await page.getByRole('button',{name:'保存',exact:true}).click();
            await expect(page.locator('.workspace-status')).toContainText('バージョン 2',{timeout:90000});
            await expect(page.locator('.workspace-status')).toContainText('保存済み');
            const next=srv.ctx.db.getArtifact(userId,artifact.id)!;
            expect(next.revision).toBe(2);
            expect(next.sha256).not.toBe(artifact.sha256);
            expect(await page.locator('[data-viewer-zoom-surface]').getAttribute('data-zoom-scale')).toBe(zoom);
            await expect(page.getByRole('button',{name:'編集',exact:true})).toHaveAttribute('aria-pressed','true');
            record.afterRevision=next.revision;record.zoom=zoom;
            if(item.kind==='markdown'||item.kind==='code'){
              const pinned=svc.getRevisionContentBlob(userId,artifact.id,2);
              expect(fs.readFileSync(pinned.blobPath,'utf8')).toBe(item.updated);
              await expect.poll(()=>page.locator('.cm-line').allTextContents()).toEqual(item.updated.split('\n'));
            }else if(item.kind==='xlsx'){
              expect(await svc.readRange(userId,artifact.id,{sheetId:'1',rangeA1:'A1:B1'})).toMatchObject({cells:[{address:'A1',value:'42',bold:true},{address:'B1',formula:'A1*2'}]});
            }else if(item.kind==='csv'){
              expect(await svc.readRange(userId,artifact.id,{startRow:0,endRow:1,startCol:0,endCol:1})).toMatchObject({rows:[['Updated item','Quantity'],['Apple','7']]});
            }else if(item.kind==='docx'){
              const result=await svc.readRange(userId,artifact.id,{start:0,count:3});
              expect(result).toMatchObject({blocks:[{text:item.updated,marks:{bold:true}},{text:'Keep formatting',uiRuns:[{text:'Keep ',bold:true,underline:true},{text:'formatting',italic:true,underline:true}]},{text:'Keep table'}]});
            }else{
              const r=await svc.readRange(userId,artifact.id,{part:'ppt/slides/slide1.xml'});
              expect(r).toMatchObject({shapes:[{text:item.updated},{name:'Overlap'}]});
              const after=await svc.renderPng(userId,artifact.id,{pageIndex:0});
              // Restore fit for the comparison, without altering the saved file.
              await page.getByRole('button',{name:'画面に合わせる'}).click();
              record.afterVisual=await capturePptx(page,info,after.png,'pptx-after');
              const draftVisual=comparePng(info.outputPath('pptx-draft-canvas.png'),info.outputPath('pptx-after-reference.png'));
              expect(draftVisual.ssim,'Unsaved sprite preview vs final saved slide').toBeGreaterThanOrEqual(.95);
              expect(draftVisual.mae).toBeLessThanOrEqual(5);
              record.draftVisual=draftVisual;
            }
            await page.getByRole('button',{name:'依頼',exact:true}).click({timeout:30000});
            if(item.kind==='markdown'||item.kind==='code'){
              const editor=page.getByRole('textbox',{name:'ソース'});
              await expect.poll(()=>page.locator('.cm-line').allTextContents()).toEqual(item.updated.split('\n'));
              await page.getByRole('button',{name:'全選択',exact:true}).click();
              await page.getByRole('button',{name:'選択行を対象にする'}).click();
            }else if(item.kind==='xlsx'||item.kind==='csv'){
              await page.getByRole('gridcell',{name:'A1',exact:true}).click({timeout:30000});
              await page.getByRole('button',{name:'セルを対象にする'}).click();
            }else if(item.kind==='docx'){
              await page.getByText(item.updated,{exact:true}).click({timeout:30000});
              await page.getByRole('button',{name:'選択段落を対象にする'}).click();
            }else{
              await page.getByRole('button',{name:'Title',exact:true}).click({timeout:60000});
              await page.getByRole('button',{name:'要素を対象にする'}).click();
            }
          }
          await page.getByRole('textbox',{name:'変更内容'}).fill('Change this selected target');
          await page.getByRole('button',{name:'依頼を追加'}).click();
          await expect(page.locator('.workspace-request-item')).toContainText('Change this selected target');
          const requests=srv.ctx.editRequestService.listRequests(userId,chatId,{artifactId:artifact.id});
          expect(requests).toHaveLength(1);
          expect(srv.ctx.editRequestService.resolveRequestTarget(requests[0]).status).toBe('resolved');
          record.pin=requests[0].selector;
          await page.screenshot({path:info.outputPath('real-'+item.kind+'-pin.png')});
          evidence.push(record);
          if(item.kind==='pptx'){
            await page.getByRole('button',{name:'編集',exact:true}).click();
            const select=page.getByRole('combobox',{name:'スライド編集操作'});
            let revision=2;
            const saveStructural=async(op:string,configure:()=>Promise<void>,renderIndex:number)=>{
              await openCommand(page,select);
              await expect(select).toBeEnabled({timeout:90000});
              await select.selectOption(op);await configure();
              await page.getByRole('button',{name:'適用',exact:true}).click();
              await expect(page.locator('[data-slide-canvas]')).toHaveAttribute('data-preview-ready','true',{timeout:90000});
              const image=page.getByRole('img',{name:'変更後のスライド'});
              await expect.poll(()=>image.evaluate(el=>(el as HTMLImageElement).complete&&(el as HTMLImageElement).naturalWidth>0),{timeout:30000}).toBe(true);
              expect(srv.ctx.db.getArtifact(userId,artifact.id)?.revision).toBe(revision);
              const previewPath=info.outputPath(op.replace('.','-')+'-draft-'+revision+'.png');
              const data=await image.evaluate(async el=>Array.from(new Uint8Array(await (await fetch((el as HTMLImageElement).src)).arrayBuffer())));
              fs.writeFileSync(previewPath,Buffer.from(data));
              await page.getByRole('button',{name:'保存',exact:true}).click();revision++;
              await expect(page.locator('.workspace-status')).toContainText('バージョン '+revision,{timeout:90000});
              await expect(page.locator('.workspace-status')).toContainText('保存済み');
              const rendered=await svc.renderPng(userId,artifact.id,{pageIndex:renderIndex});
              const expectedPath=info.outputPath(op.replace('.','-')+'-saved-'+revision+'.png');
              fs.writeFileSync(expectedPath,rendered.png);
              const visual=comparePng(previewPath,expectedPath);
              expect(visual.ssim).toBeGreaterThanOrEqual(.95);expect(visual.mae).toBeLessThanOrEqual(5);
              evidence.push({kind:'pptx-structural',op,revision,visual});
            };
            await saveStructural('pptx.add_shape',async()=>{
              await page.getByRole('textbox',{name:'追加図形テキスト'}).fill('Added by editor');
            },0);
            expect(await svc.readRange(userId,artifact.id,{part:'ppt/slides/slide1.xml'})).toMatchObject({shapes:expect.arrayContaining([expect.objectContaining({text:'Added by editor'})])});
            // The extended native structure operations are covered on both
            // Chromium and WebKit; the basic addition runs at all five sizes.
            if(vp.width===1280||vp.width===375){
              await saveStructural('pptx.add_table',async()=>{await page.getByRole('textbox',{name:'追加表 1行 1列'}).fill('Table cell')},0);
              await saveStructural('pptx.add_image',async()=>{await page.getByLabel('スライド画像ファイル').setInputFiles({name:'sample.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAIklEQVR4nGO8VKHLQA3ARBVTRg0aNWjUoFGDRg0aNYgiAACvzQGn6yar6wAAAABJRU5ErkJggg==','base64')})},0);
              await saveStructural('pptx.add_slide',async()=>{},1);
              const structure=await svc.getStructure(userId,artifact.id);
              expect(structure.slides).toHaveLength(2);
              await expect(page.getByRole('button',{name:'スライド 2',exact:true})).toHaveAttribute('aria-pressed','true');
              await saveStructural('pptx.reorder_slide',async()=>{await page.getByRole('spinbutton',{name:'移動先スライド'}).fill('1')},0);
              await expect(page.getByRole('button',{name:'スライド 1',exact:true})).toHaveAttribute('aria-pressed','true');
              page.once('dialog',d=>void d.accept());
              await saveStructural('pptx.remove_slide',async()=>{},0);
              expect((await svc.getStructure(userId,artifact.id)).slides).toHaveLength(1);
            }
          }
        })}catch(error){
          failures.push(item.kind+': '+(error instanceof Error?error.message:String(error)));
          await page.screenshot({path:info.outputPath('failed-'+item.kind+'.png')}).catch(()=>{});
        }
      }
      expect(failures,'Independent actual-file failures').toEqual([]);
    }finally{
      fs.writeFileSync(info.outputPath('pr3a-evidence.json'),JSON.stringify({viewport:vp,results:evidence,failures},null,2));
      await page.unrouteAll({behavior:'wait'});
      await srv.cleanup();
    }
  });
}
