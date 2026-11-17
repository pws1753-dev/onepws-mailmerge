// Serialize storage writes so autosave, privacy changes, and deletion cannot race.
export class WorkspaceStore {
  constructor(storage) { this.storage = storage; this.remember = true; this.queue = Promise.resolve(); }
  commit(task) {
    const operation = this.queue.then(task);
    this.queue = operation.catch(() => {});
    return operation;
  }
  async load() {
    await this.queue;
    const { preferences, templates } = await this.storage.local.get(['preferences', 'templates']);
    this.remember = preferences?.rememberWorkspace !== false;
    const area = this.remember ? this.storage.local : this.storage.session;
    const { workspace } = await area.get('workspace');
    return { workspace, templates: Array.isArray(templates) ? templates : [], remember: this.remember };
  }
  saveWorkspace(workspace) {
    const snapshot = structuredClone(workspace);
    return this.commit(async () => {
      const area = this.remember ? this.storage.local : this.storage.session;
      await area.set({ workspace: snapshot });
    });
  }
  setRemember(remember, workspace) {
    const snapshot = structuredClone(workspace);
    return this.commit(async () => {
      const previousRemember = this.remember;
      const area = remember ? this.storage.local : this.storage.session;
      const other = remember ? this.storage.session : this.storage.local;
      await area.set({ workspace: snapshot });
      try {
        // Commit a session-only preference only after its disk copy has been removed.
        await other.remove('workspace');
        await this.storage.local.set({ preferences: { rememberWorkspace: remember } });
        this.remember = remember;
      } catch (error) {
        const previousArea = previousRemember ? this.storage.local : this.storage.session;
        try {
          await previousArea.set({ workspace: snapshot });
          await this.storage.local.set({ preferences: { rememberWorkspace: previousRemember } });
          if (area !== previousArea) await area.remove('workspace');
        } catch {
          throw new Error('The privacy change could not finish or restore its previous state. Clear saved data before continuing.');
        }
        throw error;
      }
    });
  }
  saveTemplates(templates) {
    const snapshot = structuredClone(templates);
    return this.commit(() => this.storage.local.set({ templates: snapshot }));
  }
  async flush() { await this.queue; }
}
