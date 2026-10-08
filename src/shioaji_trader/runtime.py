"""Per-database single engine and Windows system sleep inhibition."""
import os
from pathlib import Path


class RuntimeLock:
    def __init__(self, database):
        self.path = Path(str(database) + ".engine.lock")
        self.handle = None

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        handle.seek(0)
        handle.write(b"0")
        handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            raise RuntimeError("此資料庫已有執行中的交易引擎") from None
        self.handle = handle

    def release(self):
        if self.handle:
            self.handle.close()
            self.handle = None


def awake(enabled):
    if os.name == "nt":
        import ctypes
        # Applies to the engine thread only; display can turn off normally.
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | (1 if enabled else 0))
