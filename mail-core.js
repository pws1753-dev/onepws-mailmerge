// Pure mail-merge and MIME utilities; no browser APIs or external dependencies.
export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    value.split('@')[0].length <= 64 &&
    /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(value) &&
    !value.split('@')[0].startsWith('.') && !value.split('@')[0].endsWith('.') && !value.split('@')[0].includes('..');
}

export function parseCSV(source) {
  if (typeof source !== 'string') throw new Error('CSV data must be text.');
  if (new TextEncoder().encode(source).length > 4 * 1024 * 1024) throw new Error('This CSV exceeds the 4 MB browser import size. Split it into smaller files.');
  source = source.replace(/^\uFEFF/, '');
  const records = [];
  let row = [], cell = '', quoted = false, closed = false;
  function endCell() { row.push(cell); cell = ''; closed = false; }
  function endRow() {
    endCell();
    if (row.some(value => value.trim() !== '')) records.push(row);
    row = [];
  }
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === ',') endCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      endRow();
    } else if (char === '"') {
      if (cell !== '' || closed) throw new Error('Invalid CSV: a quote must begin a field.');
      quoted = true;
    } else {
      if (closed) {
        if (/\s/.test(char)) continue;
        throw new Error('Invalid CSV: unexpected text after a closing quote.');
      }
      cell += char;
    }
  }
  if (quoted) throw new Error('Invalid CSV: a quoted field is missing its closing quote.');
  endRow();
  if (records.length < 2) throw new Error('Add a header row and at least one contact.');
  const headers = records.shift().map(header => header.trim());
  if (headers.some(header => !header || /[{}\r\n]/.test(header))) throw new Error('Column names must be nonempty and cannot contain braces or line breaks.');
  if (new Set(headers.map(header => header.toLowerCase())).size !== headers.length) throw new Error('Each CSV column needs a unique name.');
  const rows = records.map((values, index) => {
    if (values.length > headers.length) throw new Error(`CSV row ${index + 2} has more values than the header. Quote values containing commas.`);
    return Object.fromEntries(headers.map((header, i) => [header, (values[i] || '').trim()]));
  });
  return { headers, rows };
}

export function prepareContacts(rows, emailColumn) {
  const seen = new Set(), contacts = [], invalid = [];
  let duplicates = 0;
  for (const [index, row] of rows.entries()) {
    const email = (row[emailColumn] || '').trim();
    if (!isEmail(email)) { invalid.push(index + 2); continue; }
    const key = email.toLowerCase();
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    contacts.push({ email, fields: row });
  }
  return { contacts, invalid, duplicates };
}

export function merge(template, fields) {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name) => {
    if (!Object.hasOwn(fields, name)) throw new Error(`Unknown merge field: ${name}. Use a column name from your CSV.`);
    return fields[name];
  });
}

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeSubject(subject) {
  // Keep RFC 2047 encoded words below 75 characters without splitting UTF-8 characters.
  const words = [];
  let chunk = '';
  for (const char of subject) {
    if (new TextEncoder().encode(chunk + char).length > 42) { words.push(`=?UTF-8?B?${base64(chunk)}?=`); chunk = ''; }
    chunk += char;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64(chunk)}?=`);
  return words.join('\r\n ');
}

export function buildMessage({ from, to, subject, body }) {
  if (!isEmail(from) || !isEmail(to)) throw new Error('A valid sender and a single recipient email are required.');
  if (typeof subject !== 'string' || !subject.trim() || /[\r\n\x00]/.test(subject) || subject.length > 998) throw new Error('The subject must contain 1–998 characters and cannot contain line breaks.');
  if (!body?.trim()) throw new Error('The message body is empty.');
  const encodedBody = base64(body.replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g).join('\r\n');
  const mime = [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    '', encodedBody
  ].join('\r\n');
  return base64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function exportCSV(records) {
  return '\uFEFF' + records.map(row => row.map(value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@\-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
}
