import FormulaParser from 'fast-formula-parser';
type Cell={value:unknown;type?:string;formula?:string};
type Window={row0:number;col0:number;rows:number;cols:number};
const safeFunctions=new Set(['SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','ABS','ROUND','ROUNDUP','ROUNDDOWN','IF','IFERROR','AND','OR','NOT','SUMIF','COUNTIF','PRODUCT','MOD','SQRT','POWER']);
// The dependency's formula library includes WEBSERVICE and other expansive
// functions. This local preview accepts only bounded same-sheet arithmetic.
function allowed(formula:string){
  if(formula.length>512||/[^A-Za-z0-9_$.,:()+*/%^<>=!\-\s]/.test(formula)||formula.includes('!'))return false;
  const words=formula.match(/[A-Za-z_][A-Za-z0-9_.]*(?=\s*\()/g)??[];
  return words.every(w=>safeFunctions.has(w.toUpperCase()));
}
function column(n:number){let s='';for(;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s}
function coordinates(address:string){const m=/^([A-Z]+)([0-9]+)$/.exec(address);if(!m)return null;return {row:Number(m[2]),col:[...m[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)}}
export function previewFormulas(cells:Map<string,Cell>,sheet:string,bounds:Window){
  const results=new Map<string,string>(),memo=new Map<string,string|number|boolean|null>(),active=new Set<string>();
  let budget=10000,formulas=0;
  const inWindow=(row:number,col:number)=>row>bounds.row0&&row<=bounds.row0+bounds.rows&&col>bounds.col0&&col<=bounds.col0+bounds.cols;
  function read(ref:{row:number;col:number;sheet?:string}):string|number|boolean|null{
    if(--budget<0||active.size>20||!inWindow(ref.row,ref.col)||(ref.sheet&&ref.sheet!==sheet))throw Error('Preview range unavailable');
    const address=column(ref.col)+ref.row;
    if(memo.has(address))return memo.get(address)!;
    if(active.has(address))throw Error('Circular reference');
    const cell=cells.get(address);
    if(!cell)return null;
    if(!cell.formula){
      if(cell.type==='e')throw Error('Invalid source cell');
      const value=cell.type==='b'?String(cell.value)==='1':cell.type==='n'||cell.type==null&&typeof cell.value==='number'?Number(cell.value):String(cell.value??'');
      return typeof value==='number'&&!Number.isFinite(value)?null:value;
    }
    if(++formulas>128||!allowed(cell.formula))throw Error('Preview formula unsupported');
    active.add(address);
    try{
      const parser=new FormulaParser({
        onCell:read,
        onVariable:()=>{throw Error('Named reference unsupported')},
        onRange:range=>{
          const {from,to}=range;
          if((range.sheet&&range.sheet!==sheet)||!inWindow(from.row,from.col)||!inWindow(to.row,to.col)||(to.row-from.row+1)*(to.col-from.col+1)>1000)throw Error('Range unsupported');
          return Array.from({length:to.row-from.row+1},(_,r)=>Array.from({length:to.col-from.col+1},(_,c)=>read({row:from.row+r,col:from.col+c,sheet:range.sheet})));
        }
      });
      const v=parser.parse(cell.formula,{...ref,sheet});
      if(!(typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)))throw Error('Formula result unavailable');
      memo.set(address,v);return v;
    }finally{active.delete(address)}
  }
  for(const [address,cell]of cells){
    if(!cell.formula)continue;
    const ref=coordinates(address);if(!ref||!inWindow(ref.row,ref.col))continue;
    try{results.set(address,String(read(ref)??''))}catch{results.set(address,'未評価')}
  }
  return results;
}
