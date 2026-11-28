import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const rootDir = fileURLToPath(new URL('.', import.meta.url));
const repoDir = fileURLToPath(new URL('../..', import.meta.url));
const webNodeModules = fileURLToPath(new URL('../../web/node_modules', import.meta.url));

export default async () => {
  const reactPluginEntry = webRequire.resolve('@vitejs/plugin-react');
  const reactPluginMod = await import(pathToFileURL(reactPluginEntry).href);
  const react = reactPluginMod.default ?? reactPluginMod;
  const resolvePkgDir = (pkg: string) => path.dirname(webRequire.resolve(`${pkg}/package.json`));
  return {
    root: rootDir,
    plugins: [react()],
    resolve: {
      alias: {
        react: resolvePkgDir('react'),
        'react-dom': resolvePkgDir('react-dom'),
        katex: resolvePkgDir('katex'),
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      host: '127.0.0.1',
      port: 4174,
      strictPort: true,
      fs: { allow: [repoDir, webNodeModules] },
    },
  };
};
