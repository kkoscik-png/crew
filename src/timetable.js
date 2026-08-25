// Parser for the Stena Line "SNV" (Ventspils–Nynäshamn) PDF timetable.
// Works from PDF text items that carry x/y position info (as returned by
// unpdf's extractTextItems), reconstructing the table by column position
// rather than by raw reading order — the two ships' columns interleave in
// the text stream, so position is the only reliable signal.
//
// Only the target ship's (default: "Stena Scandica") schedule is extracted.
// Output is a repeating cycle of {v:[arrival,departure]|null, n:[...]|null}
// per day, anchored to a start date — the same shape as the "ROZKLAD.cycle"
// data structure from the reference worker.js.

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n) { return String(n).padStart(2, '0'); }
function isoDate(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }

function groupByY(items, tolerance = 2) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];
  for (const it of sorted) {
    let row = rows.find(r => Math.abs(r.y - it.y) <= tolerance);
    if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
    row.items.push(it);
  }
  rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
  return rows;
}

/**
 * @param {Array<{str:string, x:number, y:number}>} items  flat text items (single page)
 * @param {object} [opts]
 * @param {string} [opts.shipName] ship to extract, matched case-insensitively (substring)
 * @param {string} [opts.portA] first port name to match (substring, case-insensitive)
 * @param {string} [opts.portB] second port name to match (substring, case-insensitive)
 */
function parseTimetableItems(items, opts = {}) {
  const shipName = (opts.shipName || 'Stena Scandica').toLowerCase();
  const portAName = (opts.portA || 'Ventspils').toLowerCase();
  const portBName = (opts.portB || 'Nynäshamn').toLowerCase();

  const clean = items.filter(it => it.str && it.str.trim() !== '');
  const rows = groupByY(clean);

  // --- locate the title row to get the anchor year/month/day ---
  let anchor = null;
  for (const row of rows) {
    const text = row.items.map(i => i.str).join(' ');
    const m = /from\s+\w+\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i.exec(text);
    if (m) {
      const day = Number(m[1]);
      const monthIdx = MONTHS[m[2].toLowerCase()];
      const year = Number(m[3]);
      if (monthIdx !== undefined) anchor = { year, monthIdx, day };
      if (anchor) break;
    }
  }
  if (!anchor) throw new Error('Could not find the timetable start date ("timetable from ... " line).');

  // --- locate port header row: standalone labels like VENTSPILS / NYNÄSHAMN
  // (matched as a whole cell, not the combined title e.g. "VENTSPILS-NYNÄSHAMN") ---
  const isExact = (str, name) => str.trim().toLowerCase() === name;
  const portHeaderRow = rows.find(r =>
    r.items.some(i => isExact(i.str, portAName)) &&
    r.items.some(i => isExact(i.str, portBName))
  );
  if (!portHeaderRow) throw new Error('Could not find the port header row (e.g. "VENTSPILS" / "NYNÄSHAMN").');
  const portAX = portHeaderRow.items.find(i => isExact(i.str, portAName)).x;
  const portBX = portHeaderRow.items.find(i => isExact(i.str, portBName)).x;
  // The port header label isn't necessarily left-aligned with its data columns
  // (it may be centered over the block), so use it only to decide which physical
  // side (left/right) is which port — the actual column split is found below by
  // locating the largest horizontal gap between adjacent data columns.
  const leftPortKey = portAX <= portBX ? 'v' : 'n';
  const rightPortKey = leftPortKey === 'v' ? 'n' : 'v';

  // --- locate ship header row: "Stena Scandica" / "Stena Baltica" repeated ---
  const shipHeaderRow = rows.find(r =>
    r.items.some(i => i.str.toLowerCase().includes('stena')) &&
    r.y < portHeaderRow.y
  );
  if (!shipHeaderRow) throw new Error('Could not find the ship header row (e.g. "Stena Scandica").');

  // Ship labels may come through as one item ("Stena Scandica") or split
  // across two ("Stena" + "Scandica") depending on the PDF producer — handle both.
  const shipLabels = [];
  const sItems = shipHeaderRow.items;
  for (let i = 0; i < sItems.length; i++) {
    if (sItems[i].str.toLowerCase().includes('stena')) {
      if (sItems[i].str.trim().toLowerCase() === 'stena' && sItems[i + 1]) {
        shipLabels.push({ x: sItems[i].x, name: `${sItems[i].str} ${sItems[i + 1].str}` });
        i++;
      } else {
        shipLabels.push({ x: sItems[i].x, name: sItems[i].str });
      }
    }
  }
  const targetShipLabels = shipLabels.filter(s => s.name.toLowerCase().includes(shipName));
  if (targetShipLabels.length === 0) {
    throw new Error(`Could not find ship "${opts.shipName || 'Stena Scandica'}" in the timetable header.`);
  }

  // --- locate Arrival/Depart. header row to get exact column x-positions ---
  const timeHeaderRow = rows.find(r =>
    r.items.some(i => /arrival/i.test(i.str)) && r.items.some(i => /depart/i.test(i.str))
  );
  if (!timeHeaderRow) throw new Error('Could not find the "Arrival / Depart." header row.');
  const arrivals = timeHeaderRow.items.filter(i => /arrival/i.test(i.str)).map(i => i.x).sort((a, b) => a - b);
  const departs = timeHeaderRow.items.filter(i => /depart/i.test(i.str)).map(i => i.x).sort((a, b) => a - b);
  if (arrivals.length !== departs.length) throw new Error('Mismatched Arrival/Depart. column count.');

  // Pair each Arrival with the next Depart to its right, assign to the nearest ship label.
  // Port assignment: split the (x-sorted) columns into a left group and a right group at
  // the single largest horizontal gap between them — this is robust even when the port
  // header label itself isn't left-aligned with its data columns.
  let splitAt = 1, maxGap = -Infinity;
  for (let i = 1; i < arrivals.length; i++) {
    const gap = arrivals[i] - departs[i - 1];
    if (gap > maxGap) { maxGap = gap; splitAt = i; }
  }
  const columns = arrivals.map((arrX, idx) => {
    const depX = departs[idx];
    const nearestShip = shipLabels.reduce((a, b) => Math.abs(b.x - arrX) < Math.abs(a.x - arrX) ? b : a);
    return { arrX, depX, ship: nearestShip.name, port: idx < splitAt ? leftPortKey : rightPortKey };
  });
  const targetCols = columns.filter(c => c.ship.toLowerCase().includes(shipName));
  const colByPort = {};
  for (const c of targetCols) colByPort[c.port] = c;
  if (!colByPort.v || !colByPort.n) {
    throw new Error('Could not identify both port columns for the target ship.');
  }

  function nearestTimeFor(rowItems, colX, tolerance = 20) {
    let best = null, bestDist = Infinity;
    for (const it of rowItems) {
      if (!TIME_RE.test(it.str)) continue;
      const d = Math.abs(it.x - colX);
      if (d < bestDist) { bestDist = d; best = it; }
    }
    return best && bestDist <= tolerance ? best.str : null;
  }

  // --- walk data rows (below the time header, excluding the title/legend text) ---
  const dataRows = rows.filter(r => r.y < timeHeaderRow.y && !/all times are local/i.test(r.items.map(i => i.str).join(' ')));

  const days = [];
  let firstTuple = null;
  for (const row of dataRows) {
    const dow = row.items.find(i => DOW.includes(i.str));
    if (!dow) continue; // skip section-label-only rows ("odd weeks (37-39-41 etc.)")

    const vArr = nearestTimeFor(row.items, colByPort.v.arrX);
    const vDep = nearestTimeFor(row.items, colByPort.v.depX);
    const nArr = nearestTimeFor(row.items, colByPort.n.arrX);
    const nDep = nearestTimeFor(row.items, colByPort.n.depX);

    const v = vArr && vDep ? [vArr, vDep] : null;
    const n = nArr && nDep ? [nArr, nDep] : null;
    const tuple = JSON.stringify([v, n]);

    if (firstTuple === null) {
      firstTuple = tuple;
    } else if (tuple === firstTuple && days.length > 0) {
      // Wrap-around row confirming the cycle repeats — stop here.
      break;
    }
    days.push({ v, n });
  }

  if (days.length === 0) throw new Error('No timetable rows were parsed.');

  return {
    cycleStartIso: isoDate(anchor.year, anchor.monthIdx, anchor.day),
    cycleDays: days,
    shipName: targetShipLabels[0].name,
  };
}

export { parseTimetableItems };
