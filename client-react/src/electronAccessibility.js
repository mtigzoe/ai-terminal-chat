const isElectron = () =>
  typeof window !== 'undefined' &&
  typeof window.electronAPI?.chooseFolder === 'function';

export function getDesktopCapabilities() {
  return {
    isElectron: isElectron(),
    nativeProjectSelection: isElectron(),
  };
}

export function announceDesktopStatus(setStatus, message) {
  if (typeof setStatus === 'function') {
    setStatus(message);
  }
}
