export interface DesktopState { status: string; logs: string[]; settings: string; connected: boolean; error: string }
export interface TraderBridge {
  state(): Promise<DesktopState>;
  command(input: string): Promise<string>;
  saveSettings(text: string): Promise<string>;
  configure(mode: string): Promise<string>;
  authorizeLive(ack: string): Promise<string>;
  minimize(): Promise<void>;
  exit(): Promise<void>;
}
