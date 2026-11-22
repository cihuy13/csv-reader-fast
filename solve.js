// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
//
// Written fresh in this session from the RULES and the reference semantics:
// run(input) returns exactly what csv-reader 1.0.0 returns for every input
// {text, header} -> {columns, rows, errors}. Single pass, left to right.
//
// Speed shape (the reference builds every field one character at a time):
// fields are taken as slices of the input wherever the shape allows it, so
// the common field costs one slice instead of one concatenation per char.
//   - unquoted field: a charCodeAt scan to the next comma / LF / CR, then a
//     single slice. A stray CR (rare) falls into a segment path that drops
//     the CR, records stray_cr, and keeps going.
//   - quoted field: indexOf jumps to the closing quote. When the span holds
//     no doubled quote and no line break it is one slice; doubled quotes or
//     line breaks inside quotes take a segment path that collapses "" to "
//     and reads every CRLF / lone CR inside as one LF (and counts the line).
//   - what follows a closing quote is read as unquoted from there; any
//     characters kept that way are quote_junk, a quote that never closes is
//     a literal and the text after it is re-read as unquoted.
// Errors are {code, line, row} in the order met, line being the 1-based line
// the record starts on and row its index in rows (null for the header).
// Short rows are padded with "", long rows cut to the first record's width.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

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

  // Reads an unquoted field from pos, starting from `init` ('' normally,
  // '"' for the unterminated-quote re-read, the quoted value for the
  // quote-junk tail). Returns {value, ended, added}: ended is COMMA,
  // LINE_BREAK or END; added counts the characters kept after `init`.
  // A CR not followed by LF is dropped and records stray_cr.
  function scanUnquoted(init) {
    let start = pos;
    let value = init;
    let added = 0;
    let built = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        // Comma: the field ends, the record goes on.
        if (built) {
          value += text.slice(start, pos);
          added += pos - start;
        } else if (init === '') {
          value = text.slice(start, pos);
          added = pos - start;
        } else {
          value = init + text.slice(start, pos);
          added = pos - start;
        }
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        if (built) {
          value += text.slice(start, pos);
          added += pos - start;
        } else if (init === '') {
          value = text.slice(start, pos);
          added = pos - start;
        } else {
          value = init + text.slice(start, pos);
          added = pos - start;
        }
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          if (built) {
            value += text.slice(start, pos);
            added += pos - start;
          } else if (init === '') {
            value = text.slice(start, pos);
            added = pos - start;
          } else {
            value = init + text.slice(start, pos);
            added = pos - start;
          }
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        // Stray CR: drop it, record it, keep the field going.
        if (built) {
          value += text.slice(start, pos);
        } else if (init === '') {
          value = text.slice(start, pos);
          built = true;
        } else {
          value = init + text.slice(start, pos);
          built = true;
        }
        added += pos - start;
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    if (built) {
      value += text.slice(start, pos);
      added += pos - start;
    } else if (init === '') {
      value = text.slice(start, pos);
      added = pos - start;
    } else {
      value = init + text.slice(start, pos);
      added = pos - start;
    }
    return { value, ended: END, added };
  }

  // What follows a quoted field's closing quote (pos is just past it).
  function finishQuoted(value) {
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // Junk after the closing quote is appended as it stands, up to the
    // next comma or line break. Any stray CR inside it is recorded first;
    // quote_junk is recorded when the field ends, if anything was kept.
    const junk = scanUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Quoted field whose span holds a doubled quote or a line break: a
  // segment scan that collapses "" to one quote and reads every CRLF or
  // lone CR inside as one LF. pos is just past the opening quote.
  function scanQuotedSlow(open, openLine) {
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
        return finishQuoted(parts.join(''));
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
    return scanUnquoted('"');
  }

  // Quoted field: pos is at the opening quote. Jumps to the closing quote
  // with indexOf; the common span (no doubled quote, no line break) is a
  // single slice, anything else goes through the segment scan.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    const q = text.indexOf('"', pos);
    if (q === -1) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return scanUnquoted('"');
    }
    if (text.charCodeAt(q + 1) === 34) return scanQuotedSlow(open, openLine);
    const nl = text.indexOf('\n', pos);
    if (nl !== -1 && nl < q) return scanQuotedSlow(open, openLine);
    const cr = text.indexOf('\r', pos);
    if (cr !== -1 && cr < q) return scanQuotedSlow(open, openLine);
    const value = text.slice(pos, q);
    pos = q + 1;
    return finishQuoted(value);
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
        let field;
        if (text.charCodeAt(pos) === 34) {
          quoted = true;
          field = scanQuoted();
        } else {
          quoted = false;
          field = scanUnquoted('');
        }
        fields.push(field.value);
        ended = field.ended;
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
