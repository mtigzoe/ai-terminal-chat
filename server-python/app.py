# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Flask HTTP layer only.

Everything that used to live in one 2000-line app.py now lives in:
  security.py  - path containment / secrets-file detection
  tools.py     - filesystem/git/shell tools + their schemas
  prompts.py   - the system instruction, shared by every provider
  providers/   - one adapter per backend (Gemini, OpenAI-compatible)
  agent.py     - the provider-agnostic tool-calling loop

app.py just wires an HTTP request to agent.run_agent_loop() and
streams the result back out. It re-exports a few names (safe_path,
PROJECT_ROOT, is_sensitive_filename, is_command_allowed, run_command)
purely so tests/test_tools.py keeps working unchanged against
`app.<name>` — new code should import those directly from security.py
/ tools.py instead.
"""

from dotenv import load_dotenv
from flask import Flask, Response, request, stream_with_context
from flask_cors import CORS

from agent import run_agent_loop
from providers import get_provider
from security import PROJECT_ROOT, is_sensitive_filename, safe_path  # noqa: F401
from tools import is_command_allowed, run_command  # noqa: F401

# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------

load_dotenv()

# Which backend answers /chat and /stream. Set PROVIDER=gemini
# (default), ollama, or kilo in .env — see providers/__init__.py for
# what each one reads.
provider = get_provider()

app = Flask(__name__)
CORS(app)


@app.errorhandler(Exception)
def handle_unexpected_error(exc):
    """Return a JSON error instead of Flask's default 500 HTML page."""

    print(f"[Unhandled error] {exc}")

    return {
        "text": "",
        "error": f"Unexpected server error: {exc}",
    }, 500


# ---------------------------------------------------------
# Chat endpoint
# ---------------------------------------------------------

@app.route("/chat", methods=["POST"])
def chat():
    """Process a chat request and run the tool-calling loop to completion."""

    data = request.get_json(silent=True) or {}

    msg = data.get("chat", "")
    history = data.get("history", [])

    if not msg or not str(msg).strip():
        return {"text": "", "error": "Message must not be empty."}, 400

    try:
        contents = provider.build_contents(msg, history)
    except Exception as exc:
        return {
            "text": "",
            "error": f"Could not process conversation history: {exc}",
        }, 400

    tool_activity = []
    final_text = ""
    error_message = None

    try:
        for event in run_agent_loop(provider, contents):
            if event["type"] == "tool_call":
                tool_activity.append(
                    {
                        "type": "tool_call",
                        "name": event["name"],
                        "args": event["args"],
                    }
                )
            elif event["type"] == "tool_result":
                tool_activity.append(
                    {
                        "type": "tool_result",
                        "name": event["name"],
                        "result": event["result"],
                    }
                )
            elif event["type"] == "final":
                final_text = event["text"]
            elif event["type"] == "error":
                error_message = event["message"]
    except Exception as exc:
        error_message = f"Unexpected server error: {exc}"

    if error_message and not final_text:
        return {
            "text": "",
            "error": error_message,
            "tool_activity": tool_activity,
        }, 502

    return {
        "text": final_text,
        "tool_activity": tool_activity,
    }


# ---------------------------------------------------------
# Streaming endpoint
# ---------------------------------------------------------

@app.route("/stream", methods=["POST"])
def stream():
    """Stream the tool-calling loop's activity and final response.

    The existing React client reads this endpoint as plain text and
    appends every chunk directly to the message it is displaying, so
    this keeps emitting plain text (no JSON envelope) to stay
    compatible with it. Tool-call and tool-error activity is streamed
    first as short, human-readable status lines, followed by the
    model's final answer text.
    """

    def format_args(args):
        return ", ".join(f"{k}={v!r}" for k, v in args.items())

    def generate():

        data = request.get_json(silent=True) or {}

        msg = data.get("chat", "")
        history = data.get("history", [])

        if not msg or not str(msg).strip():
            yield "Please enter a message."
            return

        try:
            contents = provider.build_contents(msg, history)
        except Exception as exc:
            yield f"[Error building request: {exc}]"
            return

        try:
            for event in run_agent_loop(provider, contents):

                if event["type"] == "tool_call":
                    yield (
                        f"\n\u2699\ufe0f {event['name']}"
                        f"({format_args(event['args'])})\n"
                    )

                elif event["type"] == "tool_result":
                    result = event["result"]
                    if isinstance(result, dict) and result.get("error"):
                        yield f"\u26a0\ufe0f {event['name']}: {result['error']}\n"

                elif event["type"] == "final":
                    yield event["text"]

                elif event["type"] == "error":
                    yield f"\n[Error: {event['message']}]"

        except Exception as exc:
            # Never let an uncaught exception surface as a bare
            # connection drop / Flask 500 mid-stream.
            yield f"\n[Error: {exc}]"

    return Response(
        stream_with_context(generate()),
        mimetype="text/plain",
    )


# ---------------------------------------------------------
# Run Flask
# ---------------------------------------------------------

if __name__ == "__main__":

    import os

    port = int(
        os.getenv("PORT", "9000")
    )

    app.run(
        host="127.0.0.1",
        port=port,
    )
