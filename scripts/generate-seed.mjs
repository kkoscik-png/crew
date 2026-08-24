// Run locally with: node scripts/generate-seed.mjs <path-to-excel.xlsm> [outputPath]
// Produces public/seed.json, which is bundled as a static asset and used by the
// Worker as the initial dataset before any admin upload has happened.
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseWorkbook } from '../src/parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Użycie: node scripts/generate-seed.mjs <plik.xlsm> [wyjście.json]');
  process.exit(1);
}
const outputPath = process.argv[3] || path.join(__dirname, '../public/seed.json');

const buf = fs.readFileSync(inputPath);
const wb = XLSX.read(buf, { type: 'buffer' });
const model = parseWorkbook(XLSX, wb);

fs.writeFileSync(outputPath, JSON.stringify(model));
console.log(`OK: ${model.people.length} osób, rok ${model.sheetYear}. Zapisano do ${outputPath}`);
