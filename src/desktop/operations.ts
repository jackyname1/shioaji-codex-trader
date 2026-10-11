// Reject competing desktop changes instead of running reconnects or consent dialogs concurrently.
export class DesktopOperations {
  busy = false;
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('目前連線、模式切換或實盤確認仍在進行');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
}
