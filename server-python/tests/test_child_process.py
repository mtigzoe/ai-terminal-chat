import os
import sys
import time
from pathlib import Path
from threading import Event, Thread

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from child_process import (  # noqa: E402
    SubprocessCancelled,
    get_active_cancel_event,
    reset_active_cancel_event,
    run_cancellable,
    set_active_cancel_event,
    terminate_process_tree,
)


def test_run_cancellable_completes_quickly():
    result = run_cancellable(
        [sys.executable, "-c", "print('ok')"],
        cwd=os.getcwd(),
        timeout=5,
    )
    assert result.returncode == 0
    assert "ok" in (result.stdout or "")


def test_run_cancellable_respects_timeout():
    with pytest.raises(Exception) as exc_info:
        run_cancellable(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            cwd=os.getcwd(),
            timeout=0.3,
        )
    # TimeoutExpired from the subprocess module
    assert "timed out" in str(exc_info.value).lower() or exc_info.value.__class__.__name__ == "TimeoutExpired"


def test_run_cancellable_honors_cancel_event():
    event = Event()

    def cancel_soon():
        time.sleep(0.2)
        event.set()

    Thread(target=cancel_soon, daemon=True).start()

    with pytest.raises(SubprocessCancelled):
        run_cancellable(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            cwd=os.getcwd(),
            timeout=10,
            cancel_event=event,
        )


def test_active_cancel_event_contextvar():
    event = Event()
    token = set_active_cancel_event(event)
    try:
        assert get_active_cancel_event() is event
        event.set()
        with pytest.raises(SubprocessCancelled):
            run_cancellable(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                cwd=os.getcwd(),
                timeout=10,
            )
    finally:
        reset_active_cancel_event(token)
    assert get_active_cancel_event() is None


def test_terminate_process_tree_accepts_none():
    terminate_process_tree(None)
    terminate_process_tree(0)
