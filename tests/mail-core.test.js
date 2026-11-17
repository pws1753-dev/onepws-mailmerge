import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, prepareContacts, merge, isEmail, buildMessage, exportCSV } from '../mail-core.js';

test('CSV handles BOM, CRLF, escaped quotes, commas, blank lines, multiline cells, and empty values', () => {
  const { headers, rows } = parseCSV('\uFEFFEmail,Name,Note\r\n\r\na@example.com,"A, B","He said ""hi""\nagain"\r\nb@example.com,B,\r\n');
  assert.deepEqual(headers, ['Email', 'Name', 'Note']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Note, 'He said "hi"\nagain');
  assert.equal(rows[0].Name, 'A, B');
  assert.equal(rows[1].Note, '');
});
test('CSV rejects malformed structure and ambiguous column names', () => {
  for (const source of ['Email,email\na,b', 'Email,\na,b', 'Email\n"unfinished', 'Email\n"a"b', 'Email\na,b', 'Email\nabc"def']) {
    assert.throws(() => parseCSV(source));
  }
});
test('contacts report invalid rows and deduplicate addresses without losing fields', () => {
  const { rows } = parseCSV('Email,Name\na@example.com,A\nA@example.com,B\ninvalid,C\nb@example.com,D');
  const result = prepareContacts(rows, 'Email');
  assert.equal(result.contacts.length, 2);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.invalid, [4]);
  assert.equal(result.contacts[0].fields.Name, 'A');
});
test('merge handles spaces and rejects unknown inherited fields', () => {
  assert.equal(merge('Hi {{ First Name }}, {{Company}}!', { 'First Name': 'Zoë', Company: 'OnePWS' }), 'Hi Zoë, OnePWS!');
  assert.throws(() => merge('{{toString}}', {}));
  assert.equal(merge('{{Name}}', { Name: '<img src=x>' }), '<img src=x>');
});
test('email validation rejects header injection and multiple recipients', () => {
  for (const value of ['a@example.com\r\nBcc:x@example.com', 'a@example.com,b@example.com', 'Name <a@example.com>', 'a..b@example.com', '.a@example.com', 'a@-example.com']) assert.equal(isEmail(value), false, value);
  assert.equal(isEmail('alex+news@sub.example.com'), true);
});
test('MIME round trip preserves Unicode, long subjects, multiline body and base64url encoding', () => {
  const subject = 'Hello Zoë — नमस्ते 🌍 '.repeat(20);
  const body = 'Hi Zoë,\n\nनमस्ते 🌍\nGoodbye';
  const raw = buildMessage({ from: 'me@example.com', to: 'you@example.com', subject, body });
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.ok(mime.startsWith('From: me@example.com\r\nTo: you@example.com\r\n'));
  const [headers, encodedBody] = mime.split('\r\n\r\n');
  const decodedSubject = [...headers.matchAll(/=\?UTF-8\?B\?(.+?)\?=/g)].map(match => Buffer.from(match[1], 'base64').toString('utf8')).join('');
  assert.equal(decodedSubject, subject);
  assert.equal(Buffer.from(encodedBody.replace(/\r\n/g, ''), 'base64').toString('utf8'), body.replace(/\n/g, '\r\n'));
  assert.ok(headers.split('\r\n').every(line => line.length < 998));
});
test('message generation rejects empty messages and subject header injection', () => {
  const valid = { from: 'me@example.com', to: 'you@example.com', subject: 'Hi', body: 'Hello' };
  for (const changed of [{ subject: 'Hi\r\nBcc: x@example.com' }, { body: ' ' }, { subject: '' }, { to: 'bad' }]) assert.throws(() => buildMessage({ ...valid, ...changed }));
});
test('CSV exports escape commas, quotes, and spreadsheet formulas', () => {
  const csv = exportCSV([['Email', 'Error'], ['a@example.com', '=HYPERLINK("bad")'], ['b@example.com', 'one,two']]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"one,two"'));
});
