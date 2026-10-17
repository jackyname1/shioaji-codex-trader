export interface ActivatableWindow {isDestroyed():boolean;isMinimized():boolean;restore():void;show():void;focus():void}
export function activateWindow(window:ActivatableWindow|undefined):void {
  if(!window||window.isDestroyed())return;
  if(window.isMinimized())window.restore();
  window.show();window.focus();
}
