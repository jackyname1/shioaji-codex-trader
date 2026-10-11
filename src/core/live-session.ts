// A grant belongs to one running service and one verified broker account. It is never persisted.
export class LiveSession {
  private fingerprint?: string;
  private scope: 'trade' | 'cancel' = 'cancel';
  grant(fingerprint: string, scope: 'trade' | 'cancel' = 'trade'): void {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('實盤帳戶尚未完成核對');
    this.fingerprint = fingerprint; this.scope = scope;
  }
  authorized(fingerprint: string | undefined, scope: 'trade' | 'cancel' = 'trade'): boolean {
    return !!fingerprint && this.fingerprint === fingerprint && (this.scope === 'trade' || scope === 'cancel');
  }
  revoke(): void { this.fingerprint = undefined; }
}

export interface LiveReadiness { authorized: boolean; ready: boolean; account: string; issues: string[] }
