import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../workspace-store.js';

function fixture() {
  function area() {
    const data = {};
    return { data,
      async get(keys) { return keys === null ? structuredClone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
      async set(values) { Object.assign(data, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    };
  }
  const storage = { local: area(), session: area() };
  return { storage, store: new WorkspaceStore(storage) };
}

test('existing drafts are retained and templates load independently', async () => {
  const { storage, store } = fixture();
  storage.local.data.workspace = { draft: { csv: 'private contacts' } };
  storage.local.data.templates = [{ name: 'Welcome' }];
  const loaded = await store.load();
  assert.equal(loaded.workspace.draft.csv, 'private contacts');
  assert.equal(loaded.remember, true);
  assert.equal(loaded.templates[0].name, 'Welcome');
});
test('turning remembering off moves the workspace out of persistent storage', async () => {
  const { storage, store } = fixture();
  await store.saveWorkspace({ draft: 'private' });
  await store.setRemember(false, { draft: 'private' });
  assert.equal(storage.local.data.workspace, undefined);
  assert.equal(storage.session.data.workspace.draft, 'private');
  const reloaded = new WorkspaceStore(storage);
  assert.equal((await reloaded.load()).workspace.draft, 'private');
  delete storage.session.data.workspace;
  assert.equal((await new WorkspaceStore(storage).load()).workspace, undefined);
});
test('queued autosaves respect a concurrent privacy-mode change', async () => {
  const { storage, store } = fixture();
  await Promise.all([store.saveWorkspace({ draft: 'before' }), store.setRemember(false, { draft: 'moved' }), store.saveWorkspace({ draft: 'latest' })]);
  assert.equal(storage.local.data.workspace, undefined);
  assert.equal(storage.session.data.workspace.draft, 'latest');
  await store.setRemember(true, { draft: 'persistent again' });
  assert.equal(storage.local.data.workspace.draft, 'persistent again');
  assert.equal(storage.session.data.workspace, undefined);
});
test('failed privacy migration keeps the existing draft and persistence preference', async () => {
  const { storage, store } = fixture();
  await store.saveWorkspace({ draft: 'keep this' });
  storage.session.set = async () => { throw new Error('quota exceeded'); };
  await assert.rejects(store.setRemember(false, { draft: 'keep this' }), /quota exceeded/);
  assert.equal(store.remember, true);
  assert.equal(storage.local.data.workspace.draft, 'keep this');
});
test('snapshots prevent later UI edits from changing an in-flight save', async () => {
  const { storage, store } = fixture();
  const workspace = { draft: { subject: 'original' } };
  const pending = store.saveWorkspace(workspace); workspace.draft.subject = 'mutated'; await pending;
  assert.equal(storage.local.data.workspace.draft.subject, 'original');
});
test('session-only preference is committed only after persistent workspace deletion', async () => {
  const { storage, store } = fixture();
  await store.saveWorkspace({ draft: 'private' });
  const normalSet = storage.local.set;
  storage.local.set = async value => {
    if (value.preferences?.rememberWorkspace === false) assert.equal(storage.local.data.workspace, undefined);
    return normalSet(value);
  };
  await store.setRemember(false, { draft: 'private' });
  assert.equal(storage.local.data.preferences.rememberWorkspace, false);
});
test('preference write failure restores the previous workspace and removes the temporary copy', async () => {
  const { storage, store } = fixture();
  await store.saveWorkspace({ draft: 'private' });
  const normalSet = storage.local.set;
  storage.local.set = async value => {
    if (value.preferences?.rememberWorkspace === false) throw new Error('Preference write failed');
    return normalSet(value);
  };
  await assert.rejects(store.setRemember(false, { draft: 'private' }), /Preference write failed/);
  assert.equal(store.remember, true);
  assert.equal(storage.local.data.workspace.draft, 'private');
  assert.equal(storage.session.data.workspace, undefined);
});
