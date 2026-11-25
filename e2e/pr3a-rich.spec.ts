import {test,expect} from '@playwright/test';
import type {RichDocumentV1,RichChartNode,RichNode} from '../shared/rich-schema';

const types:RichChartNode['chartType'][]=['line','bar','hbar','pie','donut','scatter','area','stacked_bar','stacked_area','combo'];
// Novel use case: museum exhibition lighting. No production-specific widget is used.
const charts:RichChartNode[]=types.map((chartType,i)=>({
  id:'chart-'+chartType,type:'chart',chartType,title:chartType,
  categories:chartType==='scatter'?[1,2,3]:['Morning','Noon','Evening'],legend:'bottom',
  ...(chartType==='scatter'?{xAxis:{type:'number'}}:{}),
  ...(chartType==='combo'?{yAxis:{label:'Power'},yAxisRight:{label:'Temperature'}}:{}),
  series:[{key:'power',label:'Power',...(chartType==='combo'?{type:'bar' as const}:{}),data:{expr:'[2, null, $computed.total]'}},
    {key:'second',label:'Temperature',...(chartType==='combo'?{type:'line' as const,yAxisId:'right' as const}:{}),data:[10,20,30]}],
  ...(i===0?{selectedPointBind:'point'}:{})
}));
const children:RichNode[]=[
  {id:'power',type:'slider',label:'Lamp power',bind:'power',min:1,max:10,step:1},
  {id:'total',type:'kpi_card',label:'Total load',value:{expr:'$computed.total'},unit:'W'},
  {id:'description',type:'text',content:{expr:'concat("Load: ", $computed.total)'}},
  {id:'svg',type:'svg_scene',viewBox:'0 0 120 60',title:'Light coverage',elements:[{tag:'circle',id:'lamp',attrs:{cx:60,cy:30,r:{expr:'$state.power * 2'},fill:'#f0b450'}}]},
  ...charts,
  {id:'readings',type:'data_table',columns:[{key:'label',label:'Exhibit'},{key:'reading',label:'Lux',missingLabel:'Missing'}],
    rows:Array.from({length:160},(_,i)=>({label:'Exhibit '+String(i+1).padStart(3,'0'),reading:i===0?{value:null,missingReason:'Sensor offline',sourceId:'meter-a',asOf:'2026-01-01',fetchedAt:'2026-01-02T12:00:00Z'}:{value:i,sourceId:'meter-b',asOf:'2026-01-03',fetchedAt:'2026-01-04T12:00:00Z'}})),searchable:true,sortable:true,pageSize:160,selectedRowBind:'selected'},
  {id:'selected',type:'text',content:{expr:'concat("Selected: ", $state.selected + 1)'}},
  {id:'sources',type:'source_attribution',sourceIds:['meter-a','meter-b']},
  {id:'reset',type:'button',label:'Reset lighting',onClick:[{type:'reset_state'}]}
];
const doc:RichDocumentV1={schemaVersion:1,title:'Museum light planning',sources:[{id:'meter-a',name:'Meter A'},{id:'meter-b',name:'Meter B'}],state:{power:2,point:null,selected:-1},computed:{total:'$state.power * 4'},root:{id:'root',type:'stack',direction:'col',children}};
for(const vp of [{width:1280,height:720,project:'pc-chromium'},{width:1440,height:900,project:'pc-chromium'},{width:1920,height:1080,project:'pc-chromium'},{width:375,height:812,project:'iphone-webkit'},{width:430,height:932,project:'iphone-webkit'}]){
  test('schema-only novel rich UI '+vp.width+'x'+vp.height,async({page},info)=>{
    test.skip(info.project.name!==vp.project);
    await page.setViewportSize({width:vp.width,height:vp.height});
    await page.addInitScript(d=>{(window as Window&{__pr3aFixtureRichDocument?:RichDocumentV1}).__pr3aFixtureRichDocument=d},doc);
    const apiRequests:string[]=[];
    await page.route(url=>url.origin==='http://127.0.0.1:4174'&&url.pathname.startsWith('/api/'),r=>{apiRequests.push(r.request().url());return r.abort()});
    await page.goto('http://127.0.0.1:4174/?kind=rich');
    await expect(page.locator('.rich-chart')).toHaveCount(10);
    const slider=page.getByRole('slider');
    await expect(slider).toHaveValue('2');
    await slider.fill('5');
    await expect(page.getByText('Load: 20',{exact:true})).toBeVisible();
    await expect(page.locator('.rich-kpi-value')).toContainText('20');
    await expect(page.locator('svg circle').first()).toHaveAttribute('r','10');
    for(const chartType of types){
      const chart=page.locator('figure.rich-chart[aria-label="'+chartType+'"]');
      await expect(chart.locator('svg title').filter({hasText:chartType==='scatter'?'Power · 3 · 20':'Power · Evening · 20'})).toHaveCount(1);
      await expect(chart.locator('summary')).toContainText('欠損値 1 件');
    }
    await expect(page.locator('figure[aria-label="combo"] svg text').filter({hasText:'Temperature'})).toHaveCount(1);
    const table=page.locator('.rich-data-table');
    await expect(table.getByText('Sensor offline',{exact:false})).toBeVisible();
    await expect.poll(()=>table.locator('tbody tr[data-index]').count()).toBeLessThan(60);
    const scroll=table.locator('.rich-table-scroll');
    await scroll.evaluate(el=>el.scrollTop=el.scrollHeight);
    await expect(table.getByText('Exhibit 160',{exact:true})).toBeVisible();
    await table.getByText('Exhibit 160',{exact:true}).click();
    await expect(page.getByText('Selected: 160',{exact:true})).toBeVisible();
    await table.getByRole('searchbox').fill('Exhibit 001');
    await expect(table.getByText('Exhibit 001',{exact:true})).toBeVisible();
    await expect(table.getByText('Sensor offline',{exact:false})).toBeVisible();
    await table.getByRole('searchbox').fill('');
    await page.screenshot({path:info.outputPath('novel-rich.png'),fullPage:true});
    await page.getByRole('button',{name:'Reset lighting'}).click();
    await expect(slider).toHaveValue('2');
    await expect(page.getByText('Load: 8',{exact:true})).toBeVisible();
    expect(apiRequests).toEqual([]);
  });
}
