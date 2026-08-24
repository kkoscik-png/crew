// Isomorphic parser for the "Planning" sheet of the crew rotation Excel file.
// Works both under Node (local seed generation) and inside a Cloudflare Worker
// (runtime upload endpoint), given a SheetJS `XLSX` module and an ArrayBuffer.

const MONTHS = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

// Codes from the "Codes" legend (columns B/C) that represent an actual
// on-board working rank -> the person is physically on the ship that day.
// Everything else (blank, Travel Day, Leave of Absence, Parental Leave,
// Sick leave, Vacation, Course/training) means "not on board" for the
// purposes of this app.
const ONBOARD_CODES = new Set(['M', 'C', '2', '3', 'S', 'B', 'A', 'O', 'SC', 'X']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(y, mIdx, d) {
  return `${y}-${pad2(mIdx + 1)}-${pad2(d)}`;
}

function normCode(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim().toUpperCase();
  return s;
}

function cleanName(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  // Strip a trailing standalone numeric id, e.g. "Krzysztof Koscik 101" -> "Krzysztof Koscik"
  s = s.replace(/\s+\d+$/, '').trim();
  return s;
}

/**
 * Parse a workbook (already loaded with XLSX.read) into the schedule model.
 * @param {import('xlsx')} XLSX
 * @param {import('xlsx').WorkBook} wb
 */
function parseWorkbook(XLSX, wb) {
  const sheetName = wb.SheetNames.find(n => n.trim().toLowerCase() === 'planning');
  if (!sheetName) {
    throw new Error('Nie znaleziono zakładki "Planning" w pliku.');
  }
  const ws = wb.Sheets[sheetName];
  const range = XLSX.utils.decode_range(ws['!ref']);

  const cell = (r, c) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    const cellObj = ws[addr];
    return cellObj ? cellObj.v : undefined;
  };

  // Locate month header blocks: row where a cell equals a month name (case-insensitive),
  // with the year in the same column one row above.
  const monthBlocks = []; // {year, monthIdx(0-11), startCol(0-indexed), headerRow}
  let headerRow = -1;
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 5); r++) {
    let foundAny = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const v = cell(r, c);
      if (typeof v === 'string' && MONTHS.includes(v.trim().toUpperCase())) {
        const year = cell(r - 1, c);
        const monthIdx = MONTHS.indexOf(v.trim().toUpperCase());
        if (typeof year === 'number') {
          monthBlocks.push({ year, monthIdx, startCol: c, headerRow: r });
          foundAny = true;
        }
      }
    }
    if (foundAny) { headerRow = r; break; }
  }
  if (monthBlocks.length === 0) {
    throw new Error('Nie znaleziono nagłówków miesięcy w zakładce Planning.');
  }
  monthBlocks.sort((a, b) => a.startCol - b.startCol);

  // Find the "day number" row (contains 1 at the first month's start column),
  // searched a few rows below the header row.
  const jan = monthBlocks.find(m => m.monthIdx === 0) || monthBlocks[0];
  let dayNumberRow = -1;
  for (let r = headerRow + 1; r <= headerRow + 6; r++) {
    if (cell(r, jan.startCol) === 1) { dayNumberRow = r; break; }
  }
  if (dayNumberRow === -1) {
    throw new Error('Nie znaleziono wiersza z numerami dni.');
  }
  const dataStartRow = dayNumberRow + 1;

  // Build a full column -> ISO date map, and figure out the overall year
  // (assume the file covers a single calendar year).
  const year = jan.year;
  const colToDate = new Map();
  for (const block of monthBlocks) {
    const daysInMonth = new Date(block.year, block.monthIdx + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      colToDate.set(block.startCol + d - 1, isoDate(block.year, block.monthIdx, d));
    }
  }
  const allDates = [...colToDate.values()].sort();
  const yearStart = allDates[0];
  const yearEnd = allDates[allDates.length - 1];

  const nameCol = jan.startCol - 1;
  const idxCol = jan.startCol - 2;

  const people = [];
  const seenNames = new Map(); // display name -> count, for disambiguation

  for (let r = dataStartRow; r <= range.e.r; r++) {
    const nameRaw = cell(r, nameCol);
    const idxRaw = cell(r, idxCol);

    if (typeof nameRaw === 'string' && nameRaw.trim().toLowerCase() === 'portstay') {
      break; // end of crew table
    }
    if (nameRaw === undefined || nameRaw === null || nameRaw === '' || nameRaw === 0) {
      continue; // empty slot row
    }
    const name = cleanName(nameRaw);
    if (!name) continue;

    // Build per-day codes across the whole mapped date range.
    const codes = new Map(); // date -> normalized code
    for (const [col, date] of colToDate) {
      const raw = cell(r, col);
      codes.set(date, normCode(raw));
    }

    // Collapse into contiguous on-board intervals.
    const intervals = [];
    let curStart = null;
    let prevDate = null;
    for (const date of allDates) {
      const onboard = ONBOARD_CODES.has(codes.get(date));
      if (onboard && curStart === null) {
        curStart = date;
      } else if (!onboard && curStart !== null) {
        intervals.push({ start: curStart, end: prevDate });
        curStart = null;
      }
      prevDate = date;
    }
    if (curStart !== null) {
      intervals.push({ start: curStart, end: prevDate });
    }

    let displayName = name;
    if (seenNames.has(name)) {
      const n = seenNames.get(name) + 1;
      seenNames.set(name, n);
      const idxLabel = idxRaw !== undefined && idxRaw !== null && idxRaw !== '' ? idxRaw : r;
      displayName = `${name} (#${idxLabel})`;
    } else {
      seenNames.set(name, 1);
    }

    people.push({
      id: `p${r}`,
      name: displayName,
      sourceRow: r + 1, // 1-indexed, matches Excel row numbers
      intervals,
    });
  }

  people.sort((a, b) => a.name.localeCompare(b.name, 'pl'));

  return {
    generatedAt: new Date().toISOString(),
    sheetYear: year,
    yearStart,
    yearEnd,
    people,
  };
}

/**
 * Given a schedule model and a "today" ISO date, compute a person's status.
 */
function computeStatus(person, todayIso) {
  const intervals = person.intervals;
  const currentIdx = intervals.findIndex(iv => todayIso >= iv.start && todayIso <= iv.end);

  if (currentIdx !== -1) {
    const cur = intervals[currentIdx];
    const goHome = addDays(cur.end, 1);
    return {
      state: 'onboard',
      currentInterval: cur,
      goesHomeOn: goHome,
      upcoming: intervals.slice(currentIdx + 1),
    };
  }

  const nextIdx = intervals.findIndex(iv => iv.start > todayIso);
  if (nextIdx !== -1) {
    const next = intervals[nextIdx];
    return {
      state: 'home',
      nextBoarding: next.start,
      nextLeavingHome: addDays(next.end, 1),
      currentInterval: next,
      upcoming: intervals.slice(nextIdx + 1),
    };
  }

  return { state: 'unknown', upcoming: [] };
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export { parseWorkbook, computeStatus, addDays, ONBOARD_CODES };
