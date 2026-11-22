// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01) — v2.
//
// Written fresh in this session from the RULES and the reference semantics:
// run(input) returns exactly what csv-reader 1.0.0 returns for every input
// {text, header} -> {columns, rows, errors}. Single pass, left to right.
//
// v2 speed shape (v1 measured: run() ~200-230ms cold on the 6 practice
// cases, stringify ~135ms, JSON.parse ~40ms, read ~65ms, write ~35ms):
// - unquoted fields: a native regex scan for the next delimiter instead of
//   a per-character charCodeAt loop.
// - no per-field result object: scan functions write the field into shared
//   scratch variables (FV/FE/FA), so ~800k small objects per run are gone.
// - quoted fields: the common close (comma / LF / CRLF / end) is inlined
//   into scanQ instead of a finishQ call per quoted field.
// - whole-line fast path kept (quote-free line -> slice + native split).
// Errors are {code, line, row} in the order met, line being the 1-based
// line the record starts on and row its index in rows (null for header).
// Short rows are padded with "", long rows cut to the first record's width.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** Native scan for the next unquoted-field delimiter (comma, CR or LF). */
const DELIM = /[,\r\n]/g;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  // Scratch field result: FV value, FE ended (COMMA/LINE_BREAK/END),
  // FA characters kept after the init prefix.
  let FV = '';
  let FE = END;
  let FA = 0;

  // Reads an unquoted field from pos, starting from `init` ('' normally,
  // '"' for the unterminated-quote re-read, the quoted value for the
  // quote-junk tail). Sets FV/FE/FA. A CR not followed by LF is dropped
  // and records stray_cr.
  function scanU(init) {
    let start = pos;
    let value = init;
    let added = 0;
    let built = init !== '';
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (built) value += text.slice(start, n);
        else value = text.slice(start, n);
        added += n - start;
        pos = n;
        FV = value;
        FE = END;
        FA = added;
        return;
      }
      const d = m.index;
      const c = m[0];
      if (c === ',') {
        if (built) value += text.slice(start, d);
        else value = text.slice(start, d);
        added += d - start;
        pos = d + 1;
        FV = value;
        FE = COMMA;
        FA = added;
        return;
      }
      if (c === '\n') {
        if (built) value += text.slice(start, d);
        else value = text.slice(start, d);
        added += d - start;
        pos = d + 1;
        line += 1;
        FV = value;
        FE = LINE_BREAK;
        FA = added;
        return;
      }
      // c === '\r'
      if (text.charCodeAt(d + 1) === 10) {
        if (built) value += text.slice(start, d);
        else value = text.slice(start, d);
        added += d - start;
        pos = d + 2;
        line += 1;
        FV = value;
        FE = LINE_BREAK;
        FA = added;
        return;
      }
      // Stray CR: drop it, record it, keep the field going.
      if (built) value += text.slice(start, d);
      else {
        value = text.slice(start, d);
        built = true;
      }
      added += d - start;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = d + 1;
      start = pos;
    }
  }

  // What follows a quoted field's closing quote (pos is just past it).
  // Only the junk path lives here now: the common closes are inlined in
  // scanQ. Sets FV/FE/FA; quote_junk is recorded when the field ends, if
  // anything was kept (after any stray_cr inside the tail).
  function finishQ(value) {
    scanU(value);
    if (FA > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Quoted field whose span holds a doubled quote or a line break: a
  // segment scan that collapses "" to one quote and reads every CRLF or
  // lone CR inside as one LF. pos is just past the opening quote.
  // Sets FV/FE/FA.
  function scanQSlow(open, openLine) {
    let segStart = pos;
    const parts = [];
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (text.charCodeAt(pos + 1) === 34) {
          parts.push(text.slice(segStart, pos));
          parts.push('"');
          pos += 2;
          segStart = pos;
          continue;
        }
        parts.push(text.slice(segStart, pos));
        pos += 1;
        const value = parts.join('');
        if (pos >= n) {
          FV = value;
          FE = END;
          FA = 0;
          return;
        }
        const nc = text.charCodeAt(pos);
        if (nc === 44) {
          pos += 1;
          FV = value;
          FE = COMMA;
          FA = 0;
          return;
        }
        if (nc === 10) {
          pos += 1;
          line += 1;
          FV = value;
          FE = LINE_BREAK;
          FA = 0;
          return;
        }
        if (nc === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          FV = value;
          FE = LINE_BREAK;
          FA = 0;
          return;
        }
        finishQ(value);
        return;
      }
      if (c === 13) {
        parts.push(text.slice(segStart, pos));
        parts.push('\n');
        line += 1;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        segStart = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    // The quote never closes: it is a literal, the text after it is
    // re-read as unquoted, and the line count rewinds to the opening line.
    pos = open + 1;
    line = openLine;
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
    scanU('"');
  }

  // Quoted field: pos is at the opening quote. Jumps to the closing quote
  // with indexOf; the common span (no doubled quote, no line break) is a
  // single slice, anything else goes through the segment scan. The common
  // closes are inlined here. Sets FV/FE/FA.
  function scanQ() {
    const open = pos;
    const openLine = line;
    pos += 1;
    const q = text.indexOf('"', pos);
    if (q === -1) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      scanU('"');
      return;
    }
    if (text.charCodeAt(q + 1) === 34) {
      scanQSlow(open, openLine);
      return;
    }
    const nl = text.indexOf('\n', pos);
    if (nl !== -1 && nl < q) {
      scanQSlow(open, openLine);
      return;
    }
    const cr = text.indexOf('\r', pos);
    if (cr !== -1 && cr < q) {
      scanQSlow(open, openLine);
      return;
    }
    const value = text.slice(pos, q);
    pos = q + 1;
    if (pos >= n) {
      FV = value;
      FE = END;
      FA = 0;
      return;
    }
    const nc = text.charCodeAt(pos);
    if (nc === 44) {
      pos += 1;
      FV = value;
      FE = COMMA;
      FA = 0;
      return;
    }
    if (nc === 10) {
      pos += 1;
      line += 1;
      FV = value;
      FE = LINE_BREAK;
      FA = 0;
      return;
    }
    if (nc === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      FV = value;
      FE = LINE_BREAK;
      FA = 0;
      return;
    }
    finishQ(value);
  }

  while (true) {
    // Lines left with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole record line with no quote in it and no stray CR.
    // Its fields are one slice plus a native split, instead of a field at a
    // time. A line holding a quote, or a CR anywhere but the CRLF at its
    // end, falls through to the field-by-field parse below.
    let fields;
    let quoted = false;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const qInLine = text.indexOf('"', pos);
    if (qInLine === -1 || qInLine >= lineEnd) {
      const crInLine = text.indexOf('\r', pos);
      if (crInLine === -1 || crInLine >= lineEnd || (nl !== -1 && crInLine === nl - 1)) {
        const contentEnd = nl !== -1 && crInLine === nl - 1 ? nl - 1 : lineEnd;
        fields = text.slice(pos, contentEnd).split(',');
        if (nl === -1) {
          pos = n;
        } else {
          pos = nl + 1;
          line += 1;
        }
      }
    }
    if (fields === undefined) {
      fields = [];
      let ended = COMMA;
      do {
        if (text.charCodeAt(pos) === 34) {
          quoted = true;
          scanQ();
        } else {
          quoted = false;
          scanU('');
        }
        fields.push(FV);
        ended = FE;
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
