// Run locally with: node scripts/generate-timetable-seed.mjs <path-to-timetable.pdf> [outputPath]
// Produces public/timetable-seed.json, bundled as a static asset and used by
// the Worker as the initial ship timetable before any admin PDF upload.
import { getDocumentProxy, extractTextItems } from 'unpdf';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseTimetableItems } from '../src/timetable.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/generate-timetable-seed.mjs <timetable.pdf> [output.json]');
  process.exit(1);
}
const outputPath = process.argv[3] || path.join(__dirname, '../public/timetable-seed.json');

const buf = new Uint8Array(fs.readFileSync(inputPath));
const pdf = await getDocumentProxy(buf);
const { items } = await extractTextItems(pdf, { mergeHorizontalSpace: false });
const result = parseTimetableItems(items[0]);

const out = { ...result, uploadedAt: new Date().toISOString() };
fs.writeFileSync(outputPath, JSON.stringify(out));
console.log(`OK: ${result.shipName}, cycle of ${result.cycleDays.length} days starting ${result.cycleStartIso}. Wrote ${outputPath}`);
