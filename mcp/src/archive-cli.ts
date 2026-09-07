import fs from 'node:fs';
import { Archive } from './archive';
const archive = new Archive();
try {
  const [command, plan] = process.argv.slice(2);
  if (command === 'list') console.log(JSON.stringify(archive.list(), null, 2));
  else if ((command === 'preview' || command === 'apply') && plan) {
    const result = archive.batch(JSON.parse(fs.readFileSync(plan, 'utf8').replace(/^\uFEFF/, '')), command === 'preview');
    console.log(JSON.stringify(result, null, 2));
    if (result.results.some(r => r.status === 'error')) process.exitCode = 1;
  } else throw new Error('Usage: archive-cli.js list | preview plan.json | apply plan.json');
} catch (e: any) { console.error(e.message); process.exitCode = 1; }
