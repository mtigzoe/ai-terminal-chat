"""Cancel-aware subprocess runner with process-tree termination.

Mirrors server-typescript/src/child-process.ts:

* On POSIX, children are started in a new session so the whole process group
  can be signalled with killpg.
* On Windows, taskkill /T /F terminates the process tree.
* An optional threading.Event cancels an in-flight subprocess promptly instead
  of waiting for the full tool timeout.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from contextvars import ContextVar
from threading import Event, Thread
from typing import Mapping, Optional, Sequence, Union

# Active cancel event for the current tool invocation (set by the agent loop).
_cancel_event_var: ContextVar[Optional[Event]] = ContextVar(
    "ai_terminal_cancel_event", default=None
)


def set_active_cancel_event(event: Optional[Event]):
    """Bind a cancel event for the current context; returns a reset token."""
    return _cancel_event_var.set(event)


def reset_active_cancel_event(token) -> None:
    _cancel_event_var.reset(token)


def get_active_cancel_event() -> Optional[Event]:
    return _cancel_event_var.get()


class SubprocessCancelled(Exception):
    """Raised when a subprocess was terminated due to cancel_event."""


def terminate_process_tree(pid: Optional[int]) -> None:
    """Best-effort kill of a process and its descendants."""
    if not pid:
        return

    if os.name == "nt":
        # Windows: kill only terminates the immediate process. Use taskkill
        # tree mode so npm/pytest descendants are also stopped.
        try:
            subprocess.Popen(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError:
            pass
        return

    # POSIX: negative PID / killpg requires the child to be a session leader
    # (start_new_session=True when spawned).
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass


def run_cancellable(
    args: Sequence[str],
    *,
    cwd: Union[str, os.PathLike],
    timeout: float,
    cancel_event: Optional[Event] = None,
    env: Optional[Mapping[str, str]] = None,
    input_text: Optional[str] = None,
    text: bool = True,
) -> subprocess.CompletedProcess:
    """Run a subprocess with timeout and optional cooperative cancellation.

    If ``cancel_event`` is omitted, the active contextvar event (if any) is used.
    """
    event = cancel_event if cancel_event is not None else get_active_cancel_event()

    if event is not None and event.is_set():
        raise SubprocessCancelled("The operation was cancelled.")

    popen_kwargs: dict = {
        "cwd": str(cwd),
        "shell": False,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "stdin": subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
        "env": dict(env) if env is not None else None,
        "text": text,
    }
    if os.name != "nt":
        popen_kwargs["start_new_session"] = True
    else:
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    proc = subprocess.Popen(list(args), **popen_kwargs)
    box: list = []
    error_box: list = []

    def _communicate() -> None:
        try:
            out, err = proc.communicate(input=input_text)
            box.append((out, err))
        except Exception as exc:  # pragma: no cover - defensive
            error_box.append(exc)

    reader = Thread(target=_communicate, name="ai-terminal-subprocess-io", daemon=True)
    reader.start()
    deadline = time.monotonic() + float(timeout)
    cancelled = False
    timed_out = False

    try:
        while reader.is_alive():
            if event is not None and event.is_set():
                cancelled = True
                terminate_process_tree(proc.pid)
                break
            if time.monotonic() >= deadline:
                timed_out = True
                terminate_process_tree(proc.pid)
                break
            reader.join(0.1)

        reader.join(2.0)

        if cancelled:
            raise SubprocessCancelled("The operation was cancelled.")
        if timed_out:
            raise subprocess.TimeoutExpired(list(args), timeout)
        if error_box:
            raise error_box[0]
        if not box:
            # Process ended without communicate completing; treat as empty output.
            returncode = proc.poll()
            return subprocess.CompletedProcess(
                args=list(args),
                returncode=returncode if returncode is not None else -1,
                stdout="" if text else b"",
                stderr="" if text else b"",
            )

        stdout, stderr = box[0]
        returncode = proc.poll()
        return subprocess.CompletedProcess(
            args=list(args),
            returncode=returncode if returncode is not None else 0,
            stdout=stdout if stdout is not None else ("" if text else b""),
            stderr=stderr if stderr is not None else ("" if text else b""),
        )
    finally:
        if proc.poll() is None:
            terminate_process_tree(proc.pid)
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
