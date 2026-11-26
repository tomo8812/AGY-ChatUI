import {expect,test,type Page,type TestInfo} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createTestServer,TestApiClient} from '../server/tests/helpers/test-harness.js';
import type {ArtifactRecord} from '../web/src/types';
import {auditRegions,computeRegionMetrics,decodePng,type RegionAuditSpec} from './helpers/visualAudit.js';

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
  await expect(scene).toBeVisible({timeout:90000});
  await expect(scene).toHaveAttribute('data-scene-ready','true',{timeout:90000});
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
  await expect(scene.locator('img')).toHaveCount(6,{timeout:60000});
  await expect(scene.locator('[data-basic-geometry]')).toHaveCount(61);
  await expect.poll(async()=>scene.locator('img').evaluateAll(imgs=>imgs.every(img=>(img as HTMLImageElement).complete&&(img as HTMLImageElement).naturalWidth>0)),{timeout:60000}).toBe(true);
  await expect.poll(()=>scene.evaluate(el=>{
    const viewport=el.closest('.workspace-pptx-scroll');
    if(!viewport)return false;
    const a=el.getBoundingClientRect(),b=viewport.getBoundingClientRect();
    return a.top>=b.top-2&&a.bottom<=b.bottom+2&&a.left>=b.left-2&&a.right<=b.right+2;
  }),{timeout:10000}).toBe(true);
  // Verify DOM Z-order matches ascending zOrder metadata and collect per-element bboxes (geom + rendered layer ink).
  const layoutAudit=await scene.evaluate(el=>{
    const rootRect=el.getBoundingClientRect();
    const layers=Array.from(el.querySelectorAll<HTMLElement>('[data-shape-id][data-layer-kind]'));
    const zOrders=layers.map(n=>Number(n.dataset.zOrder??0));
    const zMonotonic=zOrders.every((z,i)=>i===0||z>=zOrders[i-1]);
    const hits=Array.from(el.querySelectorAll<HTMLElement>('.workspace-shape-hit[data-shape-id]')).map(btn=>{
      const r=btn.getBoundingClientRect();
      return {
        shapeId:btn.dataset.shapeId??'',
        label:btn.getAttribute('aria-label')??'',
        geom:{x:r.left-rootRect.left,y:r.top-rootRect.top,width:r.width,height:r.height},
      };
    });
    const rendered=layers.map(node=>{
      const r=node.getBoundingClientRect();
      return {
        shapeId:node.dataset.shapeId??'',
        kind:node.dataset.layerKind??'',
        ink:{x:r.left-rootRect.left,y:r.top-rootRect.top,width:r.width,height:r.height},
      };
    });
    return {width:rootRect.width,height:rootRect.height,zMonotonic,hits,rendered};
  });
  expect(layoutAudit.zMonotonic,'PPTX layer DOM Z-order must be monotonic').toBe(true);
  const actual=info.outputPath(name+'-canvas.png'),expected=info.outputPath(name+'-reference.png');
  fs.writeFileSync(expected,reference);
  // The active selection outline is chrome, not document pixels. Temporarily hide
  // hit targets in this capture only; the canvas images remain the actual DOM output.
  const style=await page.addStyleTag({content:'.workspace-shape-hit{visibility:hidden!important}'});
  try{await scene.screenshot({path:actual,scale:'css'});}finally{await style.evaluate(el=>el.remove())}
  const result=comparePng(actual,expected);
  expect(result.ssim,'Browser layer composite vs formal LibreOffice PNG').toBeGreaterThanOrEqual(.95);
  expect(result.mae,'Browser layer mean absolute error').toBeLessThanOrEqual(5);

  // Per-element & region-level bbox audit: union of geometric bounds and rendered ink bounds
  // plus exposed background corner so whole-slide SSIM cannot mask local defects.
  const actualImg=decodePng(fs.readFileSync(actual));
  const expectedImg=decodePng(reference);
  const scaleX=actualImg.width/Math.max(1,layoutAudit.width);
  const scaleY=actualImg.height/Math.max(1,layoutAudit.height);
  const keyTargets=['Title','Overlap','Grouped diagram','Attached image','Native table','Basic 1','Basic 61'];
  const regionSpecs:RegionAuditSpec[]=[];
  for(const label of keyTargets){
    const hit=layoutAudit.hits.find(h=>h.label===label);
    if(!hit)continue;
    const layer=layoutAudit.rendered.find(l=>l.shapeId===hit.shapeId);
    const x0=Math.min(hit.geom.x,layer?layer.ink.x:hit.geom.x);
    const y0=Math.min(hit.geom.y,layer?layer.ink.y:hit.geom.y);
    const x1=Math.max(hit.geom.x+hit.geom.width,layer?layer.ink.x+layer.ink.width:hit.geom.x+hit.geom.width);
    const y1=Math.max(hit.geom.y+hit.geom.height,layer?layer.ink.y+layer.ink.height:hit.geom.y+hit.geom.height);
    regionSpecs.push({
      id:hit.shapeId,
      label,
      rectPx:{x:x0*scaleX-2,y:y0*scaleY-2,width:(x1-x0)*scaleX+4,height:(y1-y0)*scaleY+4},
      minSsim:0.85,
      maxMae:10,
    });
  }
  // Exposed background/master margin region (bottom-right)
  regionSpecs.push({
    id:'background-corner',
    label:'Background/Master region',
    rectPx:{x:actualImg.width*0.85,y:actualImg.height*0.85,width:actualImg.width*0.13,height:actualImg.height*0.13},
    minSsim:0.95,
    maxMae:4,
  });
  const regionAudit=auditRegions(actualImg,expectedImg,regionSpecs);
  expect(regionAudit.failedRegions,'Per-element/region PPTX bbox visual consistency').toEqual([]);
  return {...result,regionCount:regionAudit.regions.length,zMonotonic:layoutAudit.zMonotonic,regions:regionAudit.regions.map(r=>({label:r.label,ssim:Number(r.metrics.ssim.toFixed(4)),mae:Number(r.metrics.mae.toFixed(2))}))};
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
      if(vp.width===1280){
        // Range streaming and the edit/verification adapter must agree on CR,
        // CRLF, quoted CR, and a quoted empty final row (without final newline).
        const csv=Buffer.from('\uFEFFa,b\r"c\rd",e\r\nf,g\n""');
        const regression=(await svc.createArtifact({userId,scopeKind:'chat',chatId,relPath:'line-endings.csv',content:csv,actorKind:'user',actorId:userId})).artifact;
        expect(await svc.readRange(userId,regression.id,{gridDimensions:true})).toMatchObject({totalRows:4,totalCols:2});
        expect(await svc.readRange(userId,regression.id,{startRow:0,endRow:3,startCol:0,endCol:1})).toMatchObject({rows:[['a','b'],['c\rd','e'],['f','g'],['']]});
        const {parseCsvRows}=await import('../server/src/artifacts/adapters/csv-adapter.js');
        expect(parseCsvRows(csv.toString('utf8'),',')).toEqual([['a','b'],['c\rd','e'],['f','g'],['']]);
        const longCsv=Buffer.from('first,match\r'+('x,y\r'.repeat(20000))+'last,"'+('Z'.repeat(65535))+'Needle"\r');
        const large=(await svc.createArtifact({userId,scopeKind:'chat',chatId,relPath:'long-search.csv',content:longCsv,actorKind:'user',actorId:userId})).artifact;
        expect(await svc.readRange(userId,large.id,{gridSearch:'needle',afterRow:0,afterCol:0})).toMatchObject({match:{row:20001,col:1}});
        expect(await svc.readRange(userId,large.id,{gridSearch:'MATCH',afterRow:20001,afterCol:1})).toMatchObject({match:{row:0,col:1}});
        expect(await svc.readRange(userId,large.id,{gridSearch:'absent'})).toMatchObject({match:null});
        const hugeCsv=Buffer.from('small,"'+('漢'.repeat(180000))+'"\n');
        const huge=(await svc.createArtifact({userId,scopeKind:'chat',chatId,relPath:'oversize-cell.csv',content:hugeCsv,actorKind:'user',actorId:userId})).artifact;
        expect(await svc.readRange(userId,huge.id,{startRow:0,endRow:0,startCol:0,endCol:1})).toMatchObject({rows:[],truncated:true});
        expect(await svc.readRange(userId,huge.id,{startRow:0,endRow:0,startCol:0,endCol:0})).toMatchObject({rows:[['small']],truncated:false});
        expect(await svc.readRange(userId,huge.id,{gridDimensions:true})).toMatchObject({totalRows:1,totalCols:2});
        const fullCell=await client.request<string>('GET','/api/files/'+huge.id+'/range?gridCell=true&startRow=0&endRow=0&startCol=1&endCol=1');
        expect(fullCell.status).toBe(200);
        expect(fullCell.data==='漢'.repeat(180000)).toBe(true);
        expect(fullCell.headers.get('X-Artifact-Sha256')).toBe(huge.sha256);
        const source=(await svc.createArtifact({userId,scopeKind:'chat',chatId,relPath:'large.ts',content:Buffer.from('// Original\n'),actorKind:'user',actorId:userId})).artifact;
        const content='// '+ 'x'.repeat(11*1024*1024)+'\n';
        const sourceEditUrl=srv.baseUrl+'/api/files/'+source.id+'/edit-source?expectedRevision=1&idempotencyKey=large-source';
        const sourceHeaders={'Content-Type':'text/plain; charset=utf-8',Cookie:client.cookieHeader,'x-csrf-token':decodeURIComponent(client.csrfToken)};
        const saved=await fetch(sourceEditUrl,{method:'POST',headers:sourceHeaders,body:content});
        expect(saved.status).toBe(200);
        const savedBlob=svc.getRevisionContentBlob(userId,source.id,2);
        expect(fs.readFileSync(savedBlob.blobPath,'utf8')===content).toBe(true);
        evidence.push({kind:'large-source-save',bytes:Buffer.byteLength(content),revision:2});
      }
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
            // Scroll without a pointer or wheel input (as with native
            // scrollbar/accessibility navigation). A settled jump must not
            // pin the page indicator indefinitely.
            const pdfScroll=page.locator('.pdf-canvas-scroll');
            // Page two can already fit at the top at auto scale. Create real
            // scroll travel before exercising scrollbar navigation.
            for(let step=0;step<6&&await pdfScroll.evaluate(el=>el.scrollTop<=2);step++){
              await page.getByRole('button',{name:'拡大',exact:true}).click();
              await page.locator('.pdf-nav-group').getByRole('button',{name:'前',exact:true}).click();
              await page.locator('.pdf-nav-group').getByRole('button',{name:'次',exact:true}).click();
            }
            await expect.poll(()=>pdfScroll.evaluate(el=>el.scrollTop)).toBeGreaterThan(2);
            await page.locator('.pdf-canvas-scroll').evaluate(el=>{el.scrollTop=0});
            await expect(page.locator('.pdf-page-indicator')).toContainText('1 / 2');
            await page.locator('.pdf-nav-group').getByRole('button',{name:'次',exact:true}).click();
            await expect(page.locator('.pdf-page-indicator')).toContainText('2 / 2');
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
              if(item.kind==='csv'){
                const grid=page.getByRole('grid',{name:'表データ'});
                await page.getByRole('gridcell',{name:'B2',exact:true}).click({timeout:30000});
                await grid.press('ArrowRight');await grid.press('ArrowDown');
                await expect(page.locator('.workspace-cell-address')).toHaveText('B2');
                await expect(page.getByRole('gridcell',{name:'C2',exact:true})).toHaveCount(0);
                await page.getByRole('textbox',{name:'表全体を検索'}).fill('Apple');
                await page.getByRole('button',{name:'次の一致',exact:true}).click();
                await expect(page.locator('.workspace-cell-address')).toHaveText('A2');
                await page.getByRole('textbox',{name:'表全体を検索'}).fill('');
              }
              if(item.kind==='xlsx'){
                const jump=page.getByRole('textbox',{name:'セル範囲へ移動'});
                const search=page.getByRole('textbox',{name:'シート全体を検索'});
                await search.fill('Beyond old grid window');
                await page.getByRole('button',{name:'次の一致',exact:true}).click();
                await expect(page.locator('.workspace-cell-address')).toHaveText('U51');
                await search.fill('');
                await expect(page.getByRole('gridcell',{name:'U51',exact:true})).toHaveText('Beyond old grid window',{timeout:30000});
                await jump.fill('A1');await jump.press('Enter');
                await expect(page.locator('.workspace-cell-address')).toHaveText('A1');
              }
              await page.getByRole('gridcell',{name:'A1',exact:true}).click({timeout:30000});
              await page.getByRole('textbox',{name:'数式・セル値'}).fill(item.updated);
              if(item.kind==='xlsx'){
                await expect(page.getByRole('gridcell',{name:'B1',exact:true})).toHaveText('84');
                await expect(page.getByRole('gridcell',{name:'C1',exact:true})).toHaveText('61',{timeout:30000});
                await page.getByRole('button',{name:'太字',exact:true}).click();
                await expect(page.getByRole('button',{name:'太字',exact:true})).toHaveAttribute('aria-pressed','true');
              }
            }else if(item.kind==='docx'){
              await page.getByRole('button',{name:'見出し一覧',exact:true}).click();
              await page.getByRole('navigation',{name:'文書の見出し'}).getByRole('button',{name:'Editing notes'}).click();
              await expect(page.locator('[data-word-block="4"]')).toHaveClass(/selected/);
              await page.getByRole('textbox',{name:'表 3 1行 1列'}).fill('Edited existing table');
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
              if(vp.width===1280||vp.width===375){
                const addParagraph=page.getByRole('button',{name:'段落を追加',exact:true}),addTable=page.getByRole('button',{name:'表を追加',exact:true});
                await openCommand(page,addParagraph);await addParagraph.click();
                await page.getByRole('textbox',{name:'追加段落',exact:true}).fill('First appended');
                await openCommand(page,addTable);await addTable.click();
                await page.getByRole('button',{name:'行を追加',exact:true}).click();
                await page.getByRole('button',{name:'列を追加',exact:true}).click();
                await page.getByRole('textbox',{name:'追加表 2 3行 3列',exact:true}).fill('Third row and column');
                await openCommand(page,addParagraph);await addParagraph.click();
                await page.getByRole('textbox',{name:'追加段落 3',exact:true}).fill('Last appended');
                // Revising the first draft must not reorder it after later insertions.
                await page.getByRole('textbox',{name:'追加段落',exact:true}).fill('First appended revised');
              }
            }else{
              const invalid=await client.request('POST','/api/files/'+artifact.id+'/render-draft-slide',{expectedRevision:1,pageIndex:0,operation:{op:'replace_source',content:'invalid'}});
              expect(invalid.status).toBe(400);
              const stale=await client.request('POST','/api/files/'+artifact.id+'/render-draft-slide',{expectedRevision:999,pageIndex:0,operation:{op:'pptx.add_shape',slidePart:'ppt/slides/slide1.xml',kind:'rectangle',text:'Never saved',boundsPt:[10,10,100,50]}});
              expect(stale.status).toBe(409);
              // A large slide index is a valid request shape: revision conflict
              // is checked before resolving slide identity, not an arbitrary UI cap.
              const highIndex=await client.request('POST','/api/files/'+artifact.id+'/render-draft-slide',{expectedRevision:999,pageIndex:501,operation:{op:'pptx.reorder_slide',index:501,toIndex:502}});
              expect(highIndex.status).toBe(409);
              const largerTable=await client.request('POST','/api/files/'+artifact.id+'/render-draft-slide',{expectedRevision:999,pageIndex:0,operation:{op:'pptx.add_table',slidePart:'ppt/slides/slide1.xml',boundsPt:[10,10,100,50],rows:Array.from({length:21},()=>Array(11).fill(''))}});
              expect(largerTable.status).toBe(409);
              expect(srv.ctx.db.getArtifact(userId,artifact.id)?.revision).toBe(1);
              const before=await svc.renderPng(userId,artifact.id,{pageIndex:0});
              record.beforeVisual=await capturePptx(page,info,before.png,'pptx-before');
              // Record Overlap bbox before moving so we can verify 0-ghosting in its vacated strip
              const moveStageBox=await page.locator('[data-slide-canvas="true"]').boundingBox();
              const overlapBtnPre=page.getByRole('button',{name:'Overlap',exact:true});
              const overlapBoxPre=await overlapBtnPre.boundingBox();
              await overlapBtnPre.click();
              await overlapBtnPre.press('Shift+ArrowRight');
              await overlapBtnPre.press('Shift+ArrowRight');
              await page.getByRole('button',{name:'Title',exact:true}).click();
              const textInput=page.getByRole('textbox',{name:'図形テキスト',exact:true});
              await page.getByRole('button',{name:'Title',exact:true}).press('F2');
              const canvasText=page.getByRole('textbox',{name:'キャンバス内の図形テキスト'});
              await canvasText.fill(item.updated);
              await canvasText.press('Escape');
              expect((await textInput.boundingBox())!.width).toBeGreaterThanOrEqual(90);
              const handle=page.getByRole('button',{name:'選択要素をリサイズ',exact:true});
              await expect(handle).toBeVisible();
              await handle.press('ArrowRight');
              await openCommand(page,page.getByRole('button',{name:'太字',exact:true}));
              await page.getByRole('button',{name:'太字',exact:true}).click();
              // Await actual worker output for the unsaved text; no document mutation yet.
              await expect(page.locator('[data-slide-canvas]')).toHaveAttribute('data-preview-ready','true',{timeout:90000});
              expect(srv.ctx.db.getArtifact(userId,artifact.id)?.revision).toBe(1);
              await expect.poll(()=>page.locator('[data-slide-canvas] img').evaluateAll(imgs=>imgs.length===6&&imgs.every(img=>(img as HTMLImageElement).complete&&(img as HTMLImageElement).naturalWidth>0))).toBe(true);
              const style=await page.addStyleTag({content:'.workspace-shape-hit{visibility:hidden!important}'});
              try{await page.locator('[data-slide-canvas]').screenshot({path:info.outputPath('pptx-draft-canvas.png'),scale:'css'});}finally{await style.evaluate(el=>el.remove())}
              if(moveStageBox&&overlapBoxPre){
                record.movedOverlapVacated={stage:moveStageBox,orig:overlapBoxPre};
              }
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
              expect(result).toMatchObject({blocks:[{text:item.updated,marks:{bold:true}},{text:'Keep formatting',uiRuns:[{text:'Keep ',bold:true,underline:true},{text:'formatting',italic:true,underline:true}]},{text:'Edited existing table'}]});
              if(vp.width===1280||vp.width===375){
                const added=await svc.readRange(userId,artifact.id,{start:0,count:40}) as {blocks:Array<{type:string;text:string}>};
                expect(added.blocks.filter(block=>block.type!=='sectPr').slice(-3)).toMatchObject([{type:'p',text:'First appended revised'},{type:'tbl',text:expect.stringContaining('Third row and column')},{type:'p',text:'Last appended'}]);
              }
            }else{
              const r=await svc.readRange(userId,artifact.id,{part:'ppt/slides/slide1.xml'});
              expect(r).toMatchObject({shapes:expect.arrayContaining([{text:item.updated,name:'Title'},{name:'Overlap'}, {name:'Basic 61'},{name:'Grouped diagram'},{name:'Attached image'},{name:'Native table'}].map(shape=>expect.objectContaining(shape)))});
              const after=await svc.renderPng(userId,artifact.id,{pageIndex:0});
              // Restore fit for the comparison, without altering the saved file.
              await page.getByRole('button',{name:'画面に合わせる'}).click();
              record.afterVisual=await capturePptx(page,info,after.png,'pptx-after');
              const draftVisual=comparePng(info.outputPath('pptx-draft-canvas.png'),info.outputPath('pptx-after-reference.png'));
              expect(draftVisual.ssim,'Unsaved sprite preview vs final saved slide').toBeGreaterThanOrEqual(.95);
              expect(draftVisual.mae).toBeLessThanOrEqual(5);
              record.draftVisual=draftVisual;
              // Verify vacated bbox strip from moved Overlap shape has 0 ghosting against saved LibreOffice render
              const movedInfo=record.movedOverlapVacated as {stage:{x:number;y:number;width:number;height:number};orig:{x:number;y:number;width:number;height:number}}|undefined;
              if(movedInfo){
                const actualAfter=decodePng(fs.readFileSync(info.outputPath('pptx-after-actual.png')));
                const expectedAfter=decodePng(fs.readFileSync(info.outputPath('pptx-after-reference.png')));
                const sx=actualAfter.width/Math.max(1,movedInfo.stage.width);
                const sy=actualAfter.height/Math.max(1,movedInfo.stage.height);
                const movedVacatedMetrics=computeRegionMetrics(actualAfter,expectedAfter,{
                  x:(movedInfo.orig.x-movedInfo.stage.x)*sx,
                  y:(movedInfo.orig.y-movedInfo.stage.y)*sy,
                  width:Math.max(6,20*sx*(movedInfo.stage.width/720)),
                  height:movedInfo.orig.height*sy,
                });
                expect(movedVacatedMetrics.mae,'Vacated strip after moving Overlap must have 0 ghosting').toBeLessThanOrEqual(4);
                record.movedVacatedMetrics=movedVacatedMetrics;
              }
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
          if(item.kind==='pptx')expect(requests[0].regionImageBlobSha256).toMatch(/^[0-9a-f]{64}$/);
          record.pin=requests[0].selector;
          await page.screenshot({path:info.outputPath('real-'+item.kind+'-pin.png')});
          evidence.push(record);
          await page.evaluate(()=>{document.documentElement.dataset.theme='dark'});
          const viewportFits=await page.getByRole('dialog',{name:item.filename}).evaluate(dialog=>{
            const rect=dialog.getBoundingClientRect();
            return rect.left>=-1&&rect.right<=window.innerWidth+1;
          });
          expect(viewportFits).toBe(true);
          const clipped=await page.locator('.workspace-header,.workspace-commandbar').evaluateAll(bars=>bars.flatMap(bar=>
            Array.from(bar.querySelectorAll('button')).filter(button=>button.clientWidth>0&&button.scrollWidth>button.clientWidth+2)
              .map(button=>button.textContent?.trim()??'')));
          expect(clipped).toEqual([]);
          await page.screenshot({path:info.outputPath('real-'+item.kind+'-dark.png')});
          await page.evaluate(()=>{document.documentElement.dataset.theme='light'});

          if(item.kind==='pdf'){
            await page.getByRole('combobox',{name:'PDF の選択方法'}).selectOption('region');
            const region=page.getByRole('button',{name:'ページ 2の範囲',exact:true});
            await region.focus();await region.press('Enter');await region.press('ArrowRight');await region.press('ArrowDown');await region.press('Enter');
            await expect(page.locator('.workspace-selection')).toContainText('領域',{timeout:60000});
            await page.getByRole('textbox',{name:'変更内容'}).fill('Review PDF region');
            await page.getByRole('button',{name:'依頼を追加'}).click();
            await expect(page.locator('.workspace-request-item')).toHaveCount(2);
            const regionRequest=srv.ctx.editRequestService.listRequests(userId,chatId,{artifactId:artifact.id}).find(request=>request.selector.kind==='pdf_region');
            expect(regionRequest?.selector).toMatchObject({expectedPageContentHash:expect.stringMatching(/^[0-9a-f]{64}$/),expectedRegionDigest:expect.stringMatching(/^[0-9a-f]{64}$/)});
            expect(srv.ctx.editRequestService.resolveRequestTarget(regionRequest!).status).toBe('resolved');
            evidence.push({kind:'pdf-region',selector:regionRequest!.selector});
            await page.screenshot({path:info.outputPath('real-pdf-region.png')});
          }

          if(item.kind==='csv'&&(vp.width===1280||vp.width===375)){
            // A second, independent native cell target; edit one draft and
            // remove the other. Do not pretend a saved draft has been sent.
            await page.getByRole('gridcell',{name:'B1',exact:true}).click();
            await page.getByRole('button',{name:'セルを対象にする'}).click();
            await page.getByRole('textbox',{name:'変更内容'}).fill('Change column label');
            await page.getByRole('button',{name:'依頼を追加'}).click();
            const items=page.locator('.workspace-request-item');
            await expect(items).toHaveCount(2);
            await items.filter({hasText:'Change column label'}).getByRole('button',{name:'上へ',exact:true}).click();
            await expect(items.first()).toContainText('Change column label');
            const first=items.filter({hasText:'Change this selected target'});
            await first.getByRole('button',{name:'指示を修正'}).click();
            await first.getByRole('textbox',{name:'依頼の修正'}).fill('Revised cell instruction');
            // The instruction is now an editable value, not stable DOM text.
            await items.filter({has:page.getByRole('textbox',{name:'依頼の修正'})}).getByRole('button',{name:'修正を保存'}).click();
            await expect(items.filter({hasText:'Revised cell instruction'})).toBeVisible();
            await items.filter({hasText:'Change column label'}).getByRole('button',{name:'削除',exact:true}).click();
            await expect(items).toHaveCount(1);
            expect(srv.ctx.editRequestService.listRequests(userId,chatId,{artifactId:artifact.id})).toMatchObject([{instruction:'Revised cell instruction',status:'draft'}]);
            evidence.push({kind:'multiple-target-drafts',count:2,edited:true,reordered:true,deleted:true});
          }
          if(item.kind==='code'&&(vp.width===1280||vp.width===375)){
            // Actual server revision change delivered through the harness's
            // same prop update as the workspace would receive from App.
            // The PR3B launch-path/WebSocket integration remains a separate gate.
            await page.getByRole('button',{name:'編集',exact:true}).click();
            const editor=page.getByRole('textbox',{name:'ソース'});
            await page.getByRole('button',{name:'全選択',exact:true}).click();
            const local='export const localDraft = 123;';
            await page.keyboard.insertText(local);
            await expect.poll(()=>page.locator('.cm-line').allTextContents()).toEqual([local]);
            const zoomBefore=await page.locator('[data-viewer-zoom-surface]').getAttribute('data-zoom-scale');
            const remoteText='export const remoteUpdate = 456;\n';
            const remote=await svc.editArtifact({userId,artifactId:artifact.id,expectedRevision:2,operations:[{op:'replace_source',content:remoteText}],actorKind:'ai',actorId:'pr3a-test-agent'});
            expect(remote.artifact.revision).toBe(3);
            await page.evaluate(next=>(window as Window&{__pr3aApplyArtifactUpdate?:(a:ArtifactRecord)=>void}).__pr3aApplyArtifactUpdate?.(next),remote.artifact as unknown as ArtifactRecord);
            await expect(page.locator('.workspace-status')).toContainText('バージョン 3');
            await expect(page.locator('.workspace-conflict-banner')).toBeVisible();
            await expect.poll(()=>page.locator('.cm-line').allTextContents()).toEqual([local]);
            expect(await page.locator('[data-viewer-zoom-surface]').getAttribute('data-zoom-scale')).toBe(zoomBefore);
            await expect(page.getByRole('button',{name:'編集',exact:true})).toHaveAttribute('aria-pressed','true');
            await page.getByRole('button',{name:'保存',exact:true}).click();
            const conflict=page.getByRole('alertdialog',{name:'編集の競合'});
            await expect(conflict).toBeVisible();
            expect(fs.readFileSync(svc.getRevisionContentBlob(userId,artifact.id,3).blobPath,'utf8')).toBe(remoteText);
            await conflict.getByRole('button',{name:'変更を保持'}).click();
            await expect.poll(()=>page.locator('.cm-line').allTextContents()).toEqual([local]);
            await page.getByRole('button',{name:'保存',exact:true}).click();
            page.once('dialog',dialog=>void dialog.accept());
            await conflict.getByRole('button',{name:'最新を読み直す'}).click();
            await expect.poll(()=>page.locator('.cm-line').allTextContents()).toEqual(remoteText.split('\n'));
            expect(srv.ctx.db.getArtifact(userId,artifact.id)?.revision).toBe(3);
            evidence.push({kind:'live-revision-conflict',revision:3,draftPreserved:true,zoomPreserved:true,remotePreserved:true});
          }
          if(item.kind==='pptx'){
            await page.getByRole('button',{name:'編集',exact:true}).click();
            const select=page.getByRole('combobox',{name:'スライド編集操作'});
            let revision=2;
            const stageStructural=async(op:string,configure:()=>Promise<void>)=>{
              await openCommand(page,select);
              await expect(select).toBeEnabled({timeout:90000});
              await select.selectOption(op);await configure();
              await page.getByRole('button',{name:'適用',exact:true}).click();

            };
            const saveStructural=async(op:string,configure:()=>Promise<void>,renderIndex:number)=>{
              await stageStructural(op,configure);
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
              await readySlide(page);
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
              // Verify removing a shape leaves 0 residual ghost in its vacated bbox against the saved slide
              const overlapBtn=page.getByRole('button',{name:'Overlap',exact:true});
              const sceneBox=await page.locator('[data-slide-canvas="true"]').boundingBox();
              const overlapBox=await overlapBtn.boundingBox();
              await overlapBtn.click();
              page.once('dialog',d=>void d.accept());
              await saveStructural('pptx.remove_shape',async()=>{},0);
              if(sceneBox&&overlapBox){
                const afterRemovePath=info.outputPath('pptx-after-remove-shape.png');
                const style=await page.addStyleTag({content:'.workspace-shape-hit{visibility:hidden!important}'});
                try{await page.locator('[data-slide-canvas="true"]').screenshot({path:afterRemovePath,scale:'css'});}finally{await style.evaluate(el=>el.remove())}
                const savedAfterRemove=await svc.renderPng(userId,artifact.id,{pageIndex:0});
                const actualRm=decodePng(fs.readFileSync(afterRemovePath));
                const expectedRm=decodePng(savedAfterRemove.png);
                const sx=actualRm.width/Math.max(1,sceneBox.width),sy=actualRm.height/Math.max(1,sceneBox.height);
                const vacatedMetrics=computeRegionMetrics(actualRm,expectedRm,{
                  x:(overlapBox.x-sceneBox.x)*sx,y:(overlapBox.y-sceneBox.y)*sy,
                  width:overlapBox.width*sx,height:overlapBox.height*sy,
                });
                expect(vacatedMetrics.mae,'Vacated bbox after removing Overlap must have 0 ghosting').toBeLessThanOrEqual(4);
                evidence.push({kind:'pptx-remove-ghost-check',vacatedMetrics});
              }
              await stageStructural('pptx.add_table',async()=>{await page.getByRole('textbox',{name:'追加表 1行 1列'}).fill('Table cell')});
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
