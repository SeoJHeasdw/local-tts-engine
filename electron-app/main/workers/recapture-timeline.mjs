import fs from 'node:fs/promises';
import { rebindDeckTimeline } from '../capture/deck-source.mjs';

const options = JSON.parse(process.argv[2]);
const timeline = JSON.parse(await fs.readFile(options.timeline, 'utf8'));
const refreshed = await rebindDeckTimeline(options.deckRoot, options.siteDir, timeline, options.review);
await fs.writeFile(options.timeline, `${JSON.stringify(refreshed, null, 2)}\n`, 'utf8');
