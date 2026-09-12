        result = launch_ollama_run("llama3.1")

    assert result == {"started": True, "model": "llama3.1", "pid": 4321}
    args, kwargs = popen.call_args
    assert args[0] == ["/usr/local/bin/ollama", "run", "llama3.1"]
    assert kwargs["start_new_session"] is True
    assert "creationflags" not in kwargs


def test_launch_ollama_run_opens_console_on_windows(tmp_path):
    fake_process = Mock(pid=1111)
    fake_ollama = tmp_path / "ollama.exe"
    fake_ollama.write_text("stub")
    with patch("ollama.shutil.which", return_value=str(fake_ollama)), patch(
        "ollama.platform.system", return_value="Windows"
    ), patch("ollama.subprocess.Popen", return_value=fake_process) as popen, patch(
        "ollama.subprocess.CREATE_NEW_CONSOLE", 0x00000010, create=True
    ):
        result = launch_ollama_run("qwen3.5:9b")

    assert result == {"started": True, "model": "qwen3.5:9b", "pid": 1111}
    args, kwargs = popen.call_args
    assert args[0] == [str(fake_ollama), "run", "qwen3.5:9b"]
    assert kwargs.get("creationflags") == 0x00000010


def test_launch_ollama_run_surfaces_popen_failures():
    with patch("ollama.shutil.which", return_value="/usr/local/bin/ollama"), patch(
        "ollama.platform.system", return_value="Linux"
    ), patch("ollama.subprocess.Popen", side_effect=OSError("boom")):
        result = launch_ollama_run("llama3.1")