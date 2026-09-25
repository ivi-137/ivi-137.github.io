// Lets `node --import ./scripts/ts-resolve.mjs scripts/x.mts` import site modules written without extensions.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') && !/\.\w+$/.test(spec)) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});
