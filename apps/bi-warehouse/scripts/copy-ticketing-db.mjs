import { main } from '../src/etl/copyTicketingDb.mjs';

main().catch((error) => {
  console.error(JSON.stringify({ at: new Date().toISOString(), event: 'copy_aborted', error: error.message }));
  process.exitCode = 1;
});
