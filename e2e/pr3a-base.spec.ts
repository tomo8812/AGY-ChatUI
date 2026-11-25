import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, TestApiClient } from '../server/tests/helpers/test-harness.js';
import type { ArtifactRecord } from '../web/src/types';

const fixtures=process.env.AGY_PR3A_FIXTURE_DIR;

test('Base ChatUI edits source and tables and targets PPTX through its existing viewer',async({page},info)=>{
  test.skip(info.project.name!=='pc-chromium'||!fixtures);
  test.setTimeout(180000);
  const server=await createTestServer({installDocRuntime:'off',sandboxMode:'off',allowUnsandboxedDocWorkers:false});
  try{
    const client=new TestApiClient(server.baseUrl);
    const registered=await client.request<{user:{id:string}}>('POST','/api/auth/register',{username:'base-check',displayName:'Base Check',password:'password123'});
    expect(registered.status).toBe(201);
    const userId=registered.data.user.id,chatId='base-browser';
    const workspaceDir=fs.mkdtempSync(path.join(server.dataRoot,'base-workspace-'));
    server.ctx.db.createChat({id:chatId,userId,projectId:null,title:'Base ChatUI',workspaceDir,modelId:'',effortValue:'',projectContextVersion:0});
    const create=async(filename:string,content:Buffer)=>{
      return (await server.ctx.artifactService.createArtifact({userId,scopeKind:'chat',chatId,relPath:filename,content,actorKind:'user',actorId:userId})).artifact;
    };
    const artifacts:Record<string,ArtifactRecord>={
      markdown:await create('notes.md',fs.readFileSync(path.join(fixtures!,'notes.md'))),
      code:await create('main.ts',fs.readFileSync(path.join(fixtures!,'main.ts'))),
      csv:await create('sample.csv',Buffer.from('Item,Quantity\nApple,7\nPear,10\n')),
      tsv:await create('sample.tsv',Buffer.from('Item\tQuantity\nApple\t7\nPear\t10\n')),
      pptx:await create('sample.pptx',fs.readFileSync(path.join(fixtures!,'sample.pptx'))),
    };
    const caps=await client.request<{operations:{operation:string;availability:string}[]}>('GET','/api/files/'+artifacts.pptx.id+'/capabilities');
    expect(caps.data.operations).toEqual(expect.arrayContaining([expect.objectContaining({operation:'render_png',availability:'disabled_by_resource_tier'})]));
    await page.route(url=>url.origin==='http://127.0.0.1:4174'&&url.pathname.startsWith('/api/'),async route=>{
      const request=route.request(),url=new URL(request.url());
      const response=await route.fetch({url:server.baseUrl+url.pathname+url.search,headers:{
        ...request.headers(),cookie:client.cookieHeader,'x-csrf-token':decodeURIComponent(client.csrfToken),
      },timeout:90000});
      await route.fulfill({response});
    });
    await page.addInitScript(records=>{
      const kind=new URLSearchParams(location.search).get('kind')??'';
      (window as Window&{__pr3aFixtureArtifact?:ArtifactRecord}).__pr3aFixtureArtifact=records[kind];
    },artifacts);
    const open=(kind:string)=>page.goto('http://127.0.0.1:4174/?kind='+kind);
    const save=async()=>{
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await expect(page.locator('.workspace-status')).toContainText('バージョン 2');
    };
    for(const kind of ['markdown','code']){
      await open(kind);
      await page.getByRole('button',{name:'編集',exact:true}).click();
      const editor=page.getByRole('textbox',{name:'ソース'});
      await expect(editor).toBeEditable();
      await editor.focus();await page.getByRole('button',{name:'全選択',exact:true}).click();
      await page.keyboard.insertText('Updated on Base ChatUI');
      await page.getByRole('button',{name:'依頼',exact:true}).click();
      const version=page.getByRole('dialog',{name:'依頼するバージョン'});
      if(kind==='markdown'){
        await version.getByRole('button',{name:'先に保存して依頼'}).click();
        await expect(page.getByRole('button',{name:'依頼',exact:true})).toHaveAttribute('aria-pressed','true');
        await expect(page.locator('.workspace-status')).toContainText('バージョン 2');
      }else{
        await version.getByRole('button',{name:'保存済み版へ依頼'}).click();
        await expect(page.locator('.cm-line').first()).toContainText('export const original');
        expect(server.ctx.db.getArtifact(userId,artifacts[kind].id)?.revision).toBe(1);
        await page.getByRole('button',{name:'編集',exact:true}).click();
        await expect(page.locator('.cm-line').first()).toHaveText('Updated on Base ChatUI');
        await save();
      }
      const snapshot=server.ctx.artifactService.getRevisionContentBlob(userId,artifacts[kind].id,2);
      expect(fs.readFileSync(snapshot.blobPath,'utf8')).toBe('Updated on Base ChatUI');
    }
    for(const kind of ['csv','tsv']){
      await open(kind);
      await page.getByRole('button',{name:'編集',exact:true}).click();
      await page.getByRole('textbox',{name:'行を絞り込む'}).fill('Apple');
      await page.getByRole('button',{name:'絞り込む',exact:true}).click();
      const grid=page.getByRole('grid',{name:'表データ'});
      await expect(grid).toHaveAttribute('aria-rowcount','2');
      await expect(grid.getByRole('gridcell',{name:'A2',exact:true})).toHaveText('Apple');
      await grid.getByRole('gridcell',{name:'B2',exact:true}).click();
      await page.getByRole('textbox',{name:'数式・セル値'}).fill('8');
      const select=page.getByRole('combobox',{name:'表の編集操作'});
      if(!await select.isVisible())await page.getByRole('button',{name:'その他の編集操作'}).click();
      await select.selectOption('insert_row');
      const apply=page.getByRole('button',{name:'適用',exact:true});
      if(!await apply.isVisible())await page.getByRole('button',{name:'その他の編集操作'}).click();
      await apply.click();
      if(!await select.isVisible())await page.getByRole('button',{name:'その他の編集操作'}).click();
      await select.selectOption('insert_col');
      if(!await apply.isVisible())await page.getByRole('button',{name:'その他の編集操作'}).click();
      await apply.click();
      await expect(page.getByRole('status').filter({hasText:'未保存の変更 3 件'})).toBeVisible();
      await save();
      expect(await server.ctx.artifactService.readRange(userId,artifacts[kind].id,{startRow:0,endRow:3,startCol:0,endCol:2}))
        .toMatchObject({rows:[['Item','','Quantity'],['','',''],['Apple','','8'],['Pear','','10']]});
    }
    await open('pptx');
    await expect(page.locator('canvas').first()).toBeVisible({timeout:90000});
    await page.getByRole('button',{name:'依頼',exact:true}).click();
    await page.getByRole('combobox',{name:'対象要素'}).selectOption({label:'Title'});
    await page.getByRole('button',{name:'構造を対象にする'}).click();
    await expect(page.locator('.workspace-selection')).toContainText('Title');
    await page.getByRole('textbox',{name:'変更内容'}).fill('Review the title');
    await page.getByRole('button',{name:'依頼を追加'}).click();
    await expect(page.locator('.workspace-request-item')).toHaveCount(1);
    const point=page.getByRole('button',{name:'ページ 1のピン位置',exact:true});
    await point.focus();await point.press('Enter');
    await expect(page.locator('.workspace-selection')).toContainText('スライド 1');
    await page.getByRole('textbox',{name:'変更内容'}).fill('Review this location');
    await page.getByRole('button',{name:'依頼を追加'}).click();
    await expect(page.locator('.workspace-request-item')).toHaveCount(2);
    const requests=server.ctx.editRequestService.listRequests(userId,chatId,{artifactId:artifacts.pptx.id});
    expect(requests.map(req=>req.selector.kind)).toEqual(['pptx_element','pptx_slide']);
    expect(requests[1].contentCoords).toMatchObject({unit:'pt',xPt:360,yPt:202.5});
    for(const request of requests){
      expect(request.regionImageBlobSha256).toBeNull();
      expect(server.ctx.editRequestService.resolveRequestTarget(request).status).toBe('resolved');
    }
    await page.screenshot({path:info.outputPath('base-pptx-requests.png')});
    await open('rich');
    await page.getByRole('slider').fill('5');
    await expect(page.locator('.rich-kpi-value')).toContainText('75');
    await page.getByRole('button',{name:'リセット'}).click();
    await expect(page.locator('.rich-kpi-value')).toContainText('12');
    await page.screenshot({path:info.outputPath('base-rich-ui.png')});
  }finally{
    await page.unrouteAll({behavior:'wait'});
    await server.cleanup();
  }
});
