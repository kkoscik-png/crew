import XLSX from 'xlsx';
import fs from 'fs';
import { parseWorkbook, computeStatus } from '../src/parse.js';

const path = process.argv[2];
const buf = fs.readFileSync(path);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });

const model = parseWorkbook(XLSX, wb);
console.log('Year:', model.sheetYear, model.yearStart, '->', model.yearEnd);
console.log('People count:', model.people.length);
console.log('Names:', model.people.map(p => p.name));

const today = '2026-08-24';
console.log('\n--- Sample statuses on', today, '---');
for (const p of model.people.slice(0, 6)) {
  const st = computeStatus(p, today);
  console.log(p.name, JSON.stringify(st.state === 'onboard'
    ? { state: st.state, since: st.currentInterval.start, goesHomeOn: st.goesHomeOn }
    : { state: st.state, nextBoarding: st.nextBoarding, nextLeavingHome: st.nextLeavingHome }));
}

const kk = model.people.find(p => p.name.includes('Koscik'));
console.log('\nKrzysztof Koscik intervals:', JSON.stringify(kk.intervals, null, 0));
console.log('Status today:', JSON.stringify(computeStatus(kk, today), null, 2));

fs.writeFileSync('/tmp/seed_full.json', JSON.stringify(model, null, 2));
console.log('\nWrote /tmp/seed_full.json, size=', fs.statSync('/tmp/seed_full.json').size);
