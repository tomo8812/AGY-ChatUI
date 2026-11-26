import { test, expect } from '@playwright/test';
import type { RichDocumentV1, RichNode, RichAction } from '../shared/rich-schema';

const text=(id:string,content:string):RichNode=>({id,type:'text',content});
const options=[{value:'a',label:'First'},{value:'b',label:'Second'}];
const button=(id:string,label:string,action:RichAction):Extract<RichNode,{type:'button'}>=>({id,type:'button',label,onClick:[action]});
const children:RichNode[]=[
  {id:'grid',type:'grid',columns:{pc:3,mobile:1},children:[text('grid-text','Grid item')]},
  {id:'columns',type:'columns',children:[text('columns-text','Columns item')]},
  {id:'container',type:'container',children:[text('container-text','Container item')]},
  {id:'card',type:'card',title:'Card title',footer:text('footer','Card footer'),children:[text('card-text','Card item')]},
  {id:'divider',type:'divider',label:'Divider'},
  {id:'spacer',type:'spacer',size:'sm'},
  {id:'scroll',type:'scroll_area',axis:'y',children:[text('scroll-text','Scroll item')]},
  {id:'carousel',type:'carousel',showIndicators:true,children:[text('carousel-first','Carousel first'),text('carousel-second','Carousel second')]},
  {id:'responsive',type:'responsive_box',pc:{padding:'lg',align:'end',maxWidthPx:480},mobile:{padding:'sm',align:'center',gap:'xs'},children:[text('responsive-text','Responsive item')]},
  ...(['caption','note','quote','emphasis'] as const).map(type=>({id:type,type,content:'Content '+type})),
  {id:'heading',type:'heading',level:3,content:'Section heading'},
  {id:'markdown',type:'markdown',content:'**Formatted Markdown**'},
  {id:'icon',type:'icon',name:'check',ariaLabel:'Done icon'},
  ...(['badge','status'] as const).map(type=>({id:type,type,label:'Label '+type,dot:true})),
  {id:'stat',type:'stat',label:'Stat',value:4},
  {id:'kpi',type:'kpi_card',label:'KPI',value:{expr:'$state.number'}},
  {id:'progress',type:'progress',label:'Capacity',value:{expr:'$state.number'},max:10,showPercent:true},
  ...(['list','checklist','steps','timeline'] as const).map(type=>({id:type,type,items:[{title:'Entry '+type,checked:false}]})),
  {id:'table',type:'data_table',columns:[{key:'name',label:'Name'},{key:'date',label:'Date',format:'date'},{key:'status',label:'Status',format:'badge'}],rows:[{name:{value:'Row item',tone:'info'},date:'2026-11-04',status:{value:'Ready',tone:'success'}}]},
  {id:'sources',type:'source_attribution',sourceIds:['source'],compact:true},
  {id:'mermaid',type:'mermaid',zoomable:true,code:'flowchart LR\nA[Start] --> B[End]'},
  {id:'svg',type:'svg_scene',zoomable:true,viewBox:'0 0 100 100',title:'Coverage',
    elements:[{id:'ring',tag:'circle',attrs:{cx:50,cy:50,r:{expr:'$state.number * 2'},fill:'#abc123'}}]},
  {id:'network',type:'node_edge_diagram',zoomable:true,diagramLayout:'dag_lr',nodes:[{id:'a',label:'Origin'},{id:'b',label:'Destination'}],
    edges:[{from:'a',to:'b',directed:true}],selectedNodeBind:'node'},
  {id:'chart',type:'chart',chartType:'bar',title:'Magnitude',categories:['Now'],xAxis:{unit:'week'},yAxis:{unit:'kg',format:'.1f'},referenceLines:[{axis:'y',value:1,label:'Target',tone:'warning'}],
    series:[{key:'series',label:'Readings',data:{expr:'[$state.number]'}}]},
  {id:'clickable',type:'clickable',onClick:[{type:'increment_state',key:'number'}],children:[text('increase','Increase')]},
  {id:'selectable',type:'selectable_card',selectedWhen:'$state.checked',onClick:[{type:'toggle_state',key:'checked'}],children:[text('select-card','Select card')]},
  {id:'text-input',type:'text_input',bind:'entry',label:'Short text'},
  {id:'textarea',type:'textarea',bind:'memo',label:'Long text'},
  {id:'number',type:'number_input',bind:'number',label:'Quantity',min:0,max:10},
  {id:'slider',type:'slider',bind:'number',label:'Level',min:0,max:10},
  {id:'check',type:'checkbox',bind:'checked',label:'Check entry'},
  {id:'toggle',type:'toggle',bind:'checked',label:'Toggle entry'},
  {id:'radio',type:'radio_group',bind:'choice',label:'Radio choice',options},
  {id:'select',type:'select',bind:'choice',label:'Pick choice',options},
  {id:'segmented',type:'segmented',bind:'choice',label:'Segment choice',options},
  {id:'date',type:'date_input',bind:'date',label:'Review date'},
  {id:'tabs',type:'tabs',items:[{id:'tab1',label:'Tab one',content:[text('tab-one','First tab body')]},
    {id:'tab2',label:'Tab two',content:[text('tab-two','Second tab body')]}]},
  {id:'collapsible',type:'collapsible',title:'Open details',children:[text('details','Detail body')]},
  {id:'popover',type:'popover',trigger:text('popover-trigger','Open popover'),content:'Popover body'},
  {id:'tooltip',type:'tooltip',trigger:text('tooltip-trigger','Open help'),content:'Help body'},
  {id:'form',type:'form',children:[text('form-label','Apply quantity')],onSubmit:[{type:'set_state',key:'number',valueExpr:'9'}]},
  {id:'draft',type:'editable_draft',bind:'draft',label:'Draft text',format:'markdown',
    saveAction:{type:'save_to_artifact',filenameExpr:'"draft.md"',format:'md',contentExpr:'$state.draft'}},
  {id:'code',type:'code_block',code:'const value = 2;',language:'js',copyable:false},
  {id:'diff',type:'diff_block',oldText:'old value',newText:'new value',language:'text'},
  {id:'math',type:'math_block',tex:'x^2+1'},
  {id:'media',type:'media_asset',sourceKind:'inline_svg',alt:'Media sample',
    svgScene:{id:'media-scene',type:'svg_scene',viewBox:'0 0 10 10',elements:[{tag:'rect',attrs:{width:10,height:10,fill:'#abc123'}}]}},
  {...button('copy-action','Copy result',{type:'copy_text',textExpr:'$state.entry'}),icon:'copy'},
  button('url-action','Open source link',{type:'open_external_url',urlExpr:'"https://example.test/source"'}),
  button('artifact-action','Open artifact',{type:'open_artifact',artifactIdExpr:'"fixture-artifact"'}),
  button('send-action','Send result',{type:'submit_to_chat',textExpr:'$state.memo'}),
  button('pin-action','Pin result',{type:'start_pin_edit',targetNodeId:'chart'}),
  button('reset-action','Reset result',{type:'reset_state'}),
];

const document:RichDocumentV1={schemaVersion:1,title:'Review checklist',sources:[{id:'source',name:'Measurements'}],
  state:{number:2,entry:'Initial',memo:'Original memo',checked:false,choice:'a',date:'2026-11-04',draft:'Draft',node:''},
  root:{id:'root',type:'stack',direction:'col',children}};

test('browser renders the rich UI node catalog and runs each explicit action',async({page},info)=>{
  test.skip(info.project.name!=='pc-chromium');
  test.setTimeout(120000);
  await page.addInitScript((document)=>{
    window.__pr3aFixtureRichDocument=document;
    window.__pr3aRichArtifacts=[{id:'fixture-artifact',userId:'fixture-user',chatId:'fixture-chat',filename:'result.txt'}] as never;
    const actions=()=>window.__pr3aActionLog!;
    Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async(text:string)=>{actions().push(['copy',text])}}});
    window.open=(url)=>{actions().push(['url',String(url)]);return null};
  },document);
  await page.goto('http://127.0.0.1:4174/?kind=rich-catalog');
  for(const node of children)await expect(page.locator('[data-rich-node-id="'+node.id+'"]')).toBeVisible();
  for(const id of ['mermaid','svg','network','chart','media'])await expect(page.locator('[data-rich-node-id="'+id+'"] svg').first()).toBeVisible();
  await expect(page.locator('[data-rich-node-id="math"] .katex')).toBeVisible();
  await expect(page.getByText('Formatted Markdown')).toHaveJSProperty('tagName','STRONG');
  await expect(page.locator('[data-rich-node-id="table"]')).toContainText('Row item');
  const richNode=(id:string)=>page.locator('[data-rich-node-id="'+id+'"]');
  const indicator=richNode('carousel').getByRole('button',{name:'項目 2'});
  await indicator.click();
  await expect(indicator).toHaveAttribute('aria-current','true');
  await expect(richNode('responsive').locator('.rich-responsive-box')).toHaveCSS('padding','20px');
  await expect(richNode('responsive').locator('.rich-responsive-box')).toHaveCSS('align-items','flex-end');
  await expect(richNode('responsive')).toHaveCSS('max-width','480px');
  await page.setViewportSize({width:390,height:844});
  await expect(richNode('responsive').locator('.rich-responsive-box')).toHaveCSS('padding','8px');
  await expect(richNode('responsive').locator('.rich-responsive-box')).toHaveCSS('align-items','center');
  await page.setViewportSize({width:1280,height:720});
  await expect(richNode('sources').locator('.rich-sources-compact')).toContainText('Measurements');
  await expect(richNode('table').locator('.rich-status.rich-tone-success')).toHaveText('Ready');
  await expect(richNode('table').locator('.rich-tone-info')).toHaveText('Row item');
  await expect(richNode('table').getByRole('cell',{name:'11/04/2026'})).toBeVisible();
  await expect(richNode('code').getByRole('button',{name:'コピー',exact:true})).toHaveCount(0);
  await expect(richNode('diff').getByRole('button',{name:'コピー',exact:true})).toHaveCount(2);
  await expect(richNode('copy-action').getByRole('button',{name:'Copy result'}).locator('svg')).toHaveCount(1);
  await expect(richNode('chart').getByText('Now week',{exact:true})).toBeVisible();
  await expect(richNode('chart').getByText('1.0 kg',{exact:true})).toBeVisible();
  await expect(richNode('chart').locator('.rich-chart-reference.rich-tone-warning')).toContainText('Target');
  for(const id of ['mermaid','svg','network']){
    const diagram=richNode(id);
    await diagram.getByRole('button',{name:'拡大',exact:true}).click();
    await expect.poll(async()=>Number(await diagram.locator('[data-viewer-zoom-surface]').getAttribute('data-zoom-scale'))).toBeGreaterThan(1);
  }
  await expect(richNode('media').locator('[data-viewer-zoom-surface]')).toHaveCount(0);
  expect(await page.evaluate(()=>window.__pr3aActionLog)).toEqual([]);
  await page.getByRole('textbox',{name:'Short text'}).fill('Reference text');
  await page.getByRole('textbox',{name:'Long text'}).fill('Review all readings');
  await page.getByRole('spinbutton',{name:'Quantity'}).fill('7');
  await expect(page.getByRole('progressbar')).toHaveAttribute('value','7');
  const ring=page.locator('[data-rich-node-id="svg"] circle');
  await ring.scrollIntoViewIfNeeded();
  await expect(ring).toHaveAttribute('r','14');
  await page.getByRole('button',{name:'Increase',exact:true}).press('Enter');
  await expect(page.getByRole('slider')).toHaveValue('8');
  await page.getByRole('button',{name:'Select card'}).click();
  await expect(page.getByRole('checkbox',{name:'Check entry'})).toBeChecked();
  await page.getByRole('switch',{name:'Toggle entry'}).click();
  await expect(page.getByRole('checkbox',{name:'Check entry'})).not.toBeChecked();
  await page.getByRole('combobox',{name:'Pick choice'}).selectOption({label:'Second'});
  await expect(page.getByRole('group',{name:'Segment choice'}).getByRole('radio',{name:'Second'})).toBeChecked();
  await page.getByLabel('Review date').fill('2026-11-05');
  await page.getByRole('tab',{name:'Tab one'}).press('ArrowRight');
  await expect(page.getByText('Second tab body')).toBeVisible();
  await page.getByRole('button',{name:/Open details/}).click();
  await expect(page.getByText('Detail body')).toBeVisible();
  await page.getByText('Open popover',{exact:true}).click();
  await expect(page.getByText('Popover body')).toBeVisible();
  await page.getByRole('button',{name:'ポップオーバーを閉じる'}).press('Escape');
  await richNode('tooltip').locator('.rich-overlay-trigger').focus();
  await expect(page.getByText('Help body')).toBeVisible();
  await page.getByRole('button',{name:'送信',exact:true}).click();
  await expect(page.getByRole('slider')).toHaveValue('9');
  await page.getByRole('textbox',{name:'Draft text'}).fill('**Draft result**');
  const clickConfirm=async(name:string,accept:boolean)=>{
    page.once('dialog',dialog=>void(accept?dialog.accept():dialog.dismiss()));
    await page.getByRole('button',{name,exact:true}).click();
  };
  await clickConfirm('Send result',false);
  expect(await page.evaluate(()=>window.__pr3aActionLog)).toEqual([]);
  await page.getByRole('button',{name:'Copy result'}).click();
  await clickConfirm('Open source link',true);
  await page.getByRole('button',{name:'Open artifact'}).click();
  await clickConfirm('ファイルに保存',true);
  await clickConfirm('Send result',true);
  await page.getByRole('button',{name:'Pin result'}).click();
  await expect.poll(()=>page.evaluate(()=>window.__pr3aActionLog)).toEqual([
    ['copy','Reference text'],['url','https://example.test/source'],['artifact','fixture-artifact'],
    ['save','draft.md','md','**Draft result**'],['submit','Review all readings'],['pin','chart'],
  ]);
  await page.getByRole('button',{name:'Reset result'}).click();
  await expect(page.getByRole('slider')).toHaveValue('2');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('rich-catalog.png'),fullPage:true});
});
