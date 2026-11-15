import { createApp } from './app.js';

async function main(): Promise<void> {
  const ctx = await createApp();

  const onSignal = async (signal: string) => {
    console.log(`Received ${signal}, shutting down cleanly...`);
    await ctx.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void onSignal('SIGINT'));
  process.on('SIGTERM', () => void onSignal('SIGTERM'));

  await ctx.app.listen({ host: ctx.config.host, port: ctx.config.port });
  console.log(
    `Antigravity Chat UI listening on http://${ctx.config.host}:${ctx.config.port} (agyMode=${ctx.config.agyMode})`
  );
}

main().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
