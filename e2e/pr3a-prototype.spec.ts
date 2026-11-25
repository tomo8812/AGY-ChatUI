import {test,expect,type Page} from '@playwright/test';
import {buildSyntheticPdf,buildSyntheticPng} from './fixtures/syntheticAssets';
const sizes=[{width:1280,height:720,project:'pc-chromium'},{width:1440,height:900,project:'pc-chromium'},{width:1920,height:1080,project:'pc-chromium'},{width:375,height:812,project:'iphone-webkit'},{width:430,height:932,project:'iphone-webkit'}];
const base='http://127.0.0.1:4174/';
const sha='a'.repeat(64);
async function setup(page:Page,kind:string){
  const ops:unknown[]=[];
  const meta={artifactId:'fixture',revision:1,sha256:sha};
  const opNames=kind==='xlsx'?['xlsx.set_cell','xlsx.set_formula']:kind==='docx'?['docx.set_paragraph_text']:kind==='pptx'?['pptx.set_shape_text','pptx.set_shape_bounds','render_png']:['edit'];
  const png=buildSyntheticPng(640,360);
  await page.route('**/api/files/fixture/**',async route=>{
    const u=new URL(route.request().url());
    const endpoint=u.pathname.split('/').pop();
    const json=(value:unknown)=>route.fulfill({json:value});
    if(endpoint==='capabilities')return json({format:kind,directEditUiSupported:kind!=='pdf',targetPinSupported:kind!=='pdf',operations:opNames.map(operation=>({operation,availability:'supported',scope:'mcp_and_ui'}))});
    if(endpoint==='structure')return json({...meta,...(kind==='xlsx'?{sheets:[{id:'1',name:'Sheet1',part:'xl/worksheets/sheet1.xml'}]}:{slides:[{id:'1',part:'ppt/slides/slide1.xml'}],slideSize:{widthPt:640,heightPt:360}})});
    if(endpoint==='range')return json({...meta,...(kind==='xlsx'?{cells:[{address:'A1',value:7}]}:kind==='csv'?{rows:[['Item','Quantity'],['Apple','7']],totalCols:2,hasMore:false}:kind==='docx'?{blocks:[{blockIndex:0,type:'p',text:'Introduction',editableText:true},{blockIndex:1,type:'p',text:'Protected content',editableText:false}],blockCount:2,hasMore:false}:{shapes:[{id:'2',type:'sp',name:'Title',text:'Original title',zOrder:0,transform:{geomBoundsPt:{x:50,y:30,width:250,height:100}}}]})});
    if(endpoint==='render'||endpoint==='render-draft-sprite')return route.fulfill({body:png,contentType:'image/png',headers:{'X-Artifact-Revision':'1','X-Artifact-Sha256':sha}});
    if(endpoint==='content')return route.fulfill({body:kind==='pdf'?buildSyntheticPdf([{width:595,height:842,label:'Artifact test'}]):'# Notes\n\nOriginal text\n',contentType:kind==='pdf'?'application/pdf':'text/plain'});
    if(endpoint==='edit'){ops.push(route.request().postDataJSON());return json({artifact:{id:'fixture',userId:'fixture-user',chatId:'fixture-chat',revision:1,sha256:sha},noOp:true,summary:'fixture'})}
    return json({});
  });
  await page.route('**/api/chats/fixture-chat/edit-requests**',r=>r.fulfill({json:{requests:[]}}));
  return ops;
}
for(const size of sizes){
  test('PR3A prototype controls and captures '+size.width+'x'+size.height,async({page},info)=>{
    test.skip(info.project.name!==size.project);
    test.setTimeout(120000);
    await page.setViewportSize({width:size.width,height:size.height});
    await page.goto(base+'?kind=rich');
    await expect(page.getByText('概算面積')).toBeVisible();
    await expect(page.locator('.rich-kpi-value')).toContainText('12');
    const slider=page.getByRole('slider');
    await slider.fill('4');
    await expect(page.locator('.rich-kpi-value')).toContainText('48');
    await expect(page.locator('svg circle').first()).toHaveAttribute('r','32');
    await page.screenshot({path:info.outputPath('rich.png'),fullPage:true});
    await page.getByRole('button',{name:'リセット'}).click();
    await expect(page.locator('.rich-kpi-value')).toContainText('12');
    for(const kind of ['markdown','code','xlsx','csv','docx','pptx','pdf']){
      await page.unrouteAll({behavior:'wait'});
      await setup(page,kind);
      await page.goto(base+'?kind='+kind);
      await expect(page.getByRole('dialog')).toBeVisible();
      if(kind==='pdf'){
        await expect(page.locator('canvas').first()).toBeVisible();
        await page.screenshot({path:info.outputPath('pdf.png')});
        continue;
      }
      await page.getByRole('button',{name:'編集',exact:true}).click();
      if(kind==='markdown'||kind==='code'){
        const editor=page.getByRole('textbox',{name:'ソース'});await editor.focus();await editor.press('Control+a');await page.keyboard.insertText('Updated text');
      }else if(kind==='xlsx'||kind==='csv'){
        await page.getByRole('gridcell',{name:'A1',exact:true}).click();
        await page.getByRole('textbox',{name:'数式・セル値'}).fill('42');
      }else if(kind==='docx'){
        await page.getByRole('textbox',{name:'段落 1',exact:true}).fill('Updated paragraph');
        await expect(page.getByText('書式・埋め込み要素を保持')).toBeVisible();
      }else{
        await page.getByRole('button',{name:'Title',exact:true}).click();
        await page.getByRole('textbox',{name:'図形テキスト'}).fill('Updated title');
      }
      await expect(page.getByRole('button',{name:'保存',exact:true})).toBeEnabled();
      await expect(page.getByRole('status')).toContainText('未保存');
      const viewport=await page.evaluate(()=>({w:window.innerWidth,scroll:document.documentElement.scrollWidth}));
      expect(viewport.scroll).toBeLessThanOrEqual(viewport.w+1);
      await page.screenshot({path:info.outputPath(kind+'.png')});
    }
  });
}
