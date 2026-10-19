import { registerHooks } from "node:module";

// The harness imports its modules by the `.js` names TypeScript gives them, which here are `.ts` files.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || !specifier.endsWith(".js")) throw error;
      return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
    }
  },
});

const { serve } = await import("../test/servers/serve.js");
await serve(process.argv[2]);
