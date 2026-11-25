import path from 'node:path';

/** Production graph check, based on resolved bundler module IDs rather than
 * textual source markers. A test-only fixture may not enter a release chunk. */
export function assertProductionModulePaths(ids:Iterable<string>,root:string){
  const violations:string[]=[];
  const base=path.resolve(root);
  for(const id of ids){
    const candidate=id.replace(/^\0/,'').split('?')[0].replace(/^\/\@fs\//,'/');
    if(!path.isAbsolute(candidate))continue;
    const rel=path.relative(base,candidate).split(path.sep).join('/');
    if(rel.startsWith('../')||rel==='..'||rel.includes('node_modules/'))continue;
    if(/(?:^|\/)(?:e2e|tests?|__tests__|__fixtures__|fixtures|test-results|playwright-report)(?:\/|$)/.test(rel)||/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(rel))violations.push(rel);
  }
  if(violations.length)throw new Error('Production bundle includes test-only modules:\n'+[...new Set(violations)].sort().join('\n'));
}
