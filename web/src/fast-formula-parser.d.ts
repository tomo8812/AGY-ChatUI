declare module 'fast-formula-parser' {
  interface Ref { row:number;col:number;sheet?:string }
  interface Range {from:Ref;to:Ref;sheet?:string}
  type Primitive=string|number|boolean|null;
  export default class FormulaParser {
    constructor(config:{onCell:(ref:Ref)=>Primitive;onRange:(ref:Range)=>Primitive[][];onVariable?:(name:string,sheet?:string)=>never});
    parse(formula:string,position:Ref):unknown;
  }
}
