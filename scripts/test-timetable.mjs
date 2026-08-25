import { getDocumentProxy, extractTextItems } from 'unpdf';
import fs from 'fs';
import { parseTimetableItems } from '../src/timetable.js';

const path = process.argv[2];
const buf = new Uint8Array(fs.readFileSync(path));
const pdf = await getDocumentProxy(buf);
const { items } = await extractTextItems(pdf, { mergeHorizontalSpace: false });

const result = parseTimetableItems(items[0]);
console.log('cycleStartIso:', result.cycleStartIso);
console.log('shipName:', result.shipName);
console.log('cycle length:', result.cycleDays.length);
console.log(JSON.stringify(result.cycleDays, null, 2));

// Ground truth transcribed from the user's already-verified worker.js ROZKLAD.cycle
const expected = [
  { v: ['07:30', '20:30'], n: null },
  { v: ['20:00', '23:30'], n: ['06:30', '09:00'] },
  { v: ['20:00', '23:30'], n: ['07:00', '10:00'] },
  { v: null, n: ['07:30', '21:15'] },
  { v: ['07:45', '22:45'], n: null },
  { v: null, n: ['07:45', '21:15'] },
  { v: ['07:45', '22:45'], n: null },
  { v: ['21:30', '23:59'], n: ['07:30', '11:00'] },
  { v: null, n: ['09:30', '21:15'] },
  { v: ['07:00', '10:00'], n: ['17:30', '21:30'] },
  { v: ['07:45', '23:00'], n: null },
  { v: null, n: ['07:30', '21:15'] },
  { v: ['07:45', '22:45'], n: null },
  { v: null, n: ['07:45', '21:15'] },
];

const match = JSON.stringify(result.cycleDays) === JSON.stringify(expected);
console.log('\nMATCHES VERIFIED worker.js DATA:', match);
if (!match) {
  for (let i = 0; i < expected.length; i++) {
    const got = JSON.stringify(result.cycleDays[i]);
    const exp = JSON.stringify(expected[i]);
    if (got !== exp) console.log(`  day ${i + 1}: got ${got}  expected ${exp}`);
  }
}
console.log('cycleStartIso matches 2026-09-06:', result.cycleStartIso === '2026-09-06');
