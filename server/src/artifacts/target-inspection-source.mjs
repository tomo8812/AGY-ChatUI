import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

// Source runs use the same ESM specifiers as emitted JavaScript. Resolve only
// missing relative TypeScript imports, leaving dependencies on Node's loader.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.startsWith('file:') ||
          !specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (!existsSync(candidate)) throw error;
      return next(candidate.href, context);
    }
  },
});
