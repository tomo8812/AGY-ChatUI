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
    test.setTimeout(360000);
    const srv=await createTestServer({docRuntimeDir:runtime!,installDocRuntime:'compact',sandboxMode:'off',allowUnsandboxedDocWorkers:true,docWorkerBudget:2});
    const evidence:unknown[]=[];
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
        await test.step(item.kind,async()=>{
          const artifact=artifacts[item.kind];
          await page.goto(base+'?kind='+item.kind);
          await expect(page.getByRole('dialog',{name:item.filename})).toBeVisible({timeout:30000});
          const record:Record<string,unknown>={kind:item.kind,artifactId:artifact.id,beforeRevision:artifact.revision};
          if(item.kind==='pdf'){
            await expect(page.locator('canvas').first()).toBeVisible({timeout:30000});
            await page.getByRole('button',{name:/次/}).click();
            await expect(page.locator('.pdf-page-indicator')).toContainText('2 / 2');
            await page.getByRole('button',{name:'拡大',exact:true}).click();
            const scale=await page.locator('[data-viewer-zoom-surface]').getAttribute('data-zoom-scale');
            await page.getByRole('button',{name:'依頼',exact:true}).click();
            await page.getByRole('button',{name:'ページを対象にする'}).click();
            await expect(page.locator('.workspace-selection')).toContainText('ページ 2');
            record.page=2;record.zoom=scale;
          }else{
            await page.getByRole('button',{name:'編集',exact:true}).click({timeout:30000});
            if(item.kind==='markdown'||item.kind==='code'){
              const editor=page.getByRole('textbox',{name:'ソース'});
              await expect(editor).toBeEditable({timeout:30000});
              await editor.focus();await editor.press('Control+a');await page.keyboard.insertText(item.updated);
            }else if(item.kind==='xlsx'||item.kind==='csv'){
              await page.getByRole('gridcell',{name:'A1',exact:true}).click({timeout:30000});
              await page.getByRole('textbox',{name:'数式・セル値'}).fill(item.updated);
              if(item.kind==='xlsx')await expect(page.getByRole('gridcell',{name:'B1',exact:true})).toHaveText('84');
            }else if(item.kind==='docx'){
              await page.getByRole('textbox',{name:'段落 1',exact:true}).fill(item.updated,{timeout:30000});
              await expect(page.getByText('書式・埋め込み要素を保持')).toBeVisible();
            }else{
              const before=await svc.renderPng(userId,artifact.id,{pageIndex:0});
              record.beforeVisual=await capturePptx(page,info,before.png,'pptx-before');
              await page.getByRole('button',{name:'Title',exact:true}).click();
              await page.getByRole('textbox',{name:'図形テキスト'}).fill(item.updated);
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
              expect(await svc.readRange(userId,artifact.id,{sheetId:'1',rangeA1:'A1:B1'})).toMatchObject({cells:[{address:'A1',value:'42'},{address:'B1',formula:'A1*2'}]});
            }else if(item.kind==='csv'){
              expect(await svc.readRange(userId,artifact.id,{startRow:0,endRow:1,startCol:0,endCol:1})).toMatchObject({rows:[['Updated item','Quantity'],['Apple','7']]});
            }else if(item.kind==='docx'){
              const result=await svc.readRange(userId,artifact.id,{start:0,count:3});
              expect(result).toMatchObject({blocks:[{text:item.updated},{text:'Keep formatting'},{text:'Keep table'}]});
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
              await editor.focus();await editor.press('Control+Home');await editor.press('Shift+End');
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
        });
      }
    }finally{
      fs.writeFileSync(info.outputPath('pr3a-evidence.json'),JSON.stringify({viewport:vp,results:evidence},null,2));
      await page.unrouteAll({behavior:'wait'});
      await srv.cleanup();
    }
  });
}
