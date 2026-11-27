import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {describe,it,expect} from 'vitest';
import {assertProductionModulePaths,assertProductionModuleContent} from '../../web/build/production-boundary.js';

const ROOT=path.resolve(import.meta.dirname,'../..');
const WEB=path.join(ROOT,'web/src');
const WORKSPACE='web/src/components/ArtifactWorkspace/';
const REGISTRY=WORKSPACE+'modules/registry.ts';
const SHELL=WORKSPACE+'WorkspaceShell.tsx';
const MODULES=WORKSPACE+'modules/';
function walk(dir:string):string[]{
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(dir,entry.name);
    return entry.isDirectory()?walk(file):/\.[jt]sx?$/.test(file)&&!file.endsWith('.d.ts')?[file]:[];
  });
}
const rel=(file:string)=>path.relative(ROOT,file).split(path.sep).join('/');
type Graph=Map<string,Set<string>>;
function graphFromSources(sources:Map<string,string>):Graph{
  const graph:Graph=new Map();
  for(const [file,source]of sources){
    const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('x')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    const edges=new Set<string>();graph.set(file,edges);
    function add(spec:string){
      if(!spec.startsWith('.'))return;
      const stem=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec.replace(/\.js$/,'')));
      for(const resolved of [stem,stem+'.ts',stem+'.tsx',stem+'/index.ts',stem+'/index.tsx']){
        if(sources.has(resolved)){edges.add(resolved);break}
      }
    }
    function visit(node:ts.Node){
      if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&!node.importClause?.isTypeOnly){
        const bindings=node.importClause?.namedBindings;
        if(!node.importClause?.name&&bindings&&ts.isNamedImports(bindings)&&bindings.elements.length>0&&bindings.elements.every(e=>e.isTypeOnly))return;
        add(node.moduleSpecifier.text);
      }
      if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&!node.isTypeOnly)add(node.moduleSpecifier.text);
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments.length===1&&ts.isStringLiteral(node.arguments[0]))add(node.arguments[0].text);
      ts.forEachChild(node,visit);
    }
    visit(sf);
  }
  return graph;
}
function checkWorkspace(graph:Graph):string[]{
  const violations:string[]=[];
  const formats=[...graph.keys()].filter(file=>file.startsWith(MODULES)&&file!==REGISTRY);
  function reach(start:string,forbidden:Set<string>){
    const visited=new Set<string>(),active=new Set<string>();
    function dfs(file:string,chain:string[]){
      if(file===REGISTRY)return;
      if(active.has(file)){violations.push('cycle: '+[...chain,file].join(' -> '));return}
      if(visited.has(file))return;
      if(forbidden.has(file)){violations.push('reverse/cross dependency: '+[...chain,file].join(' -> '));return}
      visited.add(file);active.add(file);
      for(const target of graph.get(file)??[])dfs(target,[...chain,file]);
      active.delete(file);
    }
    dfs(start,[]);
  }
  reach(SHELL,new Set(formats));
  for(const format of formats)reach(format,new Set(formats.filter(f=>f!==format)));
  return violations;
}
function checkPdfOwnership(sources:Map<string,string>):string[]{
  const out:string[]=[];
  const expected='web/src/components/shared-ui/document/PdfCanvasCore.tsx';
  const owners:string[]=[];
  for(const [file,source]of sources){
    const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('x')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    function visit(node:ts.Node){
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments.length===1&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text==='pdfjs-dist')owners.push(file);
      if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==='pdfjs-dist'&&!node.importClause?.isTypeOnly)owners.push(file);
      ts.forEachChild(node,visit);
    }
    visit(sf);
  }
  if(owners.length!==1||owners[0]!==expected)out.push('PDF.js ownership: '+owners.join(', '));
  return out;
}
describe('PR3A frontend architecture boundaries',()=>{
  it('ARCH-11: registry-removal graph has no shell-to-module, cross-format or cyclic runtime dependencies',()=>{
    const sources=new Map(walk(WEB).map(file=>[rel(file),fs.readFileSync(file,'utf8')]));
    const graph=graphFromSources(sources);
    expect(graph.has(REGISTRY)).toBe(true);
    expect(checkWorkspace(graph)).toEqual([]);
    expect(checkPdfOwnership(sources)).toEqual([]);
  });
  it('ARCH-11 negative: catches transitive shell bypass, cross-format import and cycle',()=>{
    const a=MODULES+'Alpha.tsx',b=MODULES+'Beta.tsx',helper=WORKSPACE+'helper.ts';
    const sources=new Map([[SHELL,"import './helper'"],[helper,"import './modules/Alpha'"],[a,"import './Beta'"],[b,"import '../helper'"],[REGISTRY,"import './Alpha';import './Beta'"]]);
    const violations=checkWorkspace(graphFromSources(sources));
    expect(violations.some(v=>v.includes('reverse/cross dependency')&&v.includes(helper))).toBe(true);
    const cycle=new Map([[SHELL,"import './helper'"],[helper,"import './WorkspaceShell'"],[REGISTRY,'']]);
    expect(checkWorkspace(graphFromSources(cycle)).some(v=>v.startsWith('cycle:'))).toBe(true);
    expect(checkPdfOwnership(new Map([['web/src/clone.ts',"import('pdfjs-dist')"]]))).not.toEqual([]);
  });
  it('NEG-11: production graph rejects test assets but accepts user-facing code and external dependencies',()=>{
    const fixture=path.join(ROOT,'e2e/fixtures/syntheticAssets.ts');
    expect(()=>assertProductionModulePaths([fixture],ROOT)).toThrow('test-only modules');
    expect(()=>assertProductionModulePaths([path.join(ROOT,'web/src/components/ArtifactWorkspace/index.tsx'),path.join(ROOT,'node_modules/lib/tests/asset.js')],ROOT)).not.toThrow();
  });
  it('NEG-11: detects hard-coded sample content inside an otherwise ordinary product module',()=>{
    const module='web/src/components/Overview.tsx';
    expect(()=>assertProductionModuleContent(module, "const headline={city:'Tokyo',temperature:25,condition:'Sunny'}")).toThrow('fixed demo data');
    expect(()=>assertProductionModuleContent(module, "const prices=[{ticker:'TEST',price:42,change:2}]")).toThrow('fixed demo data');
    expect(()=>assertProductionModuleContent(module, "const sample={schemaVersion:1,root:{type:'text',content:'Fixed demo'}}")).toThrow('fixed demo data');
    expect(()=>assertProductionModuleContent(module, "const demoRows=[['Sample', 42]]")).toThrow('fixed demo data');
    expect(()=>assertProductionModuleContent(module, "const columns=['Temperature','Condition']; const view={schemaVersion:1,root:reply.root};")).not.toThrow();
  });
});
