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

import os
import subprocess
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, request, stream_with_context
from flask_cors import CORS
from google import genai
from google.genai import types


# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------

load_dotenv()

api_key = os.getenv("GOOGLE_API_KEY")

if not api_key:
    raise RuntimeError(
        "GOOGLE_API_KEY is not set. "
        "Add it to your .env file."
    )

client = genai.Client(
    api_key=api_key
)

MODEL_NAME = "gemini-3.5-flash-lite"

app = Flask(__name__)
CORS(app)


# ---------------------------------------------------------
# Security: restrict filesystem access
# ---------------------------------------------------------

PROJECT_ROOT = Path.cwd().resolve()


def safe_path(path: str) -> Path:
    """Resolve a path while keeping it inside the application directory."""

    requested = (PROJECT_ROOT / path).resolve()

    try:
        requested.relative_to(PROJECT_ROOT)
    except ValueError:
        raise ValueError(
            "Access outside the project directory is not allowed."
        )

    return requested


# ---------------------------------------------------------
# Gemini filesystem tools
# ---------------------------------------------------------

def list_files(path: str = ".") -> dict:
    """List files and directories inside the application project.

    Args:
        path: Relative directory path inside the project.
              Use "." for the project root.

    Returns:
        A dictionary containing the directory entries.
    """

    try:
        directory = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if not directory.exists():
        return {"error": f"Path does not exist: {path}"}

    if not directory.is_dir():
        return {"error": f"Not a directory: {path}"}

    entries = []

    for item in sorted(
        directory.iterdir(),
        key=lambda p: p.name.lower()
    ):
        entries.append(
            {
                "name": item.name,
                "type": "directory" if item.is_dir() else "file",
            }
        )

    return {
        "path": str(directory.relative_to(PROJECT_ROOT)),
        "entries": entries,
    }


def read_file(path: str) -> dict:
    """Read a UTF-8 text file inside the application project.

    Args:
        path: Relative path to the text file.

    Returns:
        A dictionary containing the file contents.
    """

    try:
        file_path = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if not file_path.exists():
        return {"error": f"File does not exist: {path}"}

    if not file_path.is_file():
        return {"error": f"Not a file: {path}"}

    # Prevent accidentally sending extremely large files to Gemini.
    max_size = 200_000

    if file_path.stat().st_size > max_size:
        return {
            "error": (
                f"File is too large to read. "
                f"Maximum size is {max_size} bytes."
            )
        }

    try:
        contents = file_path.read_text(
            encoding="utf-8"
        )
    except UnicodeDecodeError:
        return {
            "error": "The file is not a UTF-8 text file."
        }

    return {
        "path": str(file_path.relative_to(PROJECT_ROOT)),
        "contents": contents,
    }


# ---------------------------------------------------------
# Gemini terminal tool
# ---------------------------------------------------------

ALLOWED_COMMANDS = {
    "git status",
    "git branch",
    "git log",
    "git diff",
    "git remote -v",
    "dir",
    "pwd",
    "python --version",
    "node --version",
    "npm --version",
}


def run_command(command: str) -> dict:
    """Run an allowlisted read-only command in the project directory.

    Args:
        command: One of the explicitly allowed commands.

    Returns:
        The command, exit code, stdout, and stderr.
    """

    command = command.strip()

    if command not in ALLOWED_COMMANDS:
        return {
            "error": (
                f"Command not allowed: {command}. "
                f"Allowed commands: "
                f"{sorted(ALLOWED_COMMANDS)}"
            )
        }

    try:
        result = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
        )

        return {
            "command": command,
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }

    except subprocess.TimeoutExpired:
        return {
            "error": "Command timed out after 30 seconds."
        }

    except Exception as exc:
        return {
            "error": f"Could not execute command: {exc}"
        }


# ---------------------------------------------------------
# Tool registry
# ---------------------------------------------------------

TOOL_FUNCTIONS = {
    "list_files": list_files,
    "read_file": read_file,
    "run_command": run_command,
}


# ---------------------------------------------------------
# Gemini function declarations
# ---------------------------------------------------------

list_files_declaration = types.FunctionDeclaration(
    name="list_files",
    description=(
        "Lists files and directories inside the local project. "
        "Use this when the user asks what files exist or asks "
        "you to inspect a local directory."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": (
                    "Relative directory path. "
                    "Use '.' for the project root."
                ),
            }
        },
        "required": [],
    },
)


read_file_declaration = types.FunctionDeclaration(
    name="read_file",
    description=(
        "Reads the contents of a UTF-8 text file inside the local "
        "project. Use this when the user asks you to inspect a "
        "specific local file."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": (
                    "Relative path to the file inside the project."
                ),
            }
        },
        "required": ["path"],
    },
)


run_command_declaration = types.FunctionDeclaration(
    name="run_command",
    description=(
        "Runs one of the explicitly allowed read-only commands "
        "inside the local project directory. Use this when the "
        "user asks you to check git status, git branch, git log, "
        "git diff, directory contents, or software versions."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "command": {
                "type": "STRING",
                "description": (
                    "An allowed command such as "
                    "'git status', 'git branch', 'git log', "
                    "'dir', or 'npm --version'."
                ),
            }
        },
        "required": ["command"],
    },
)


TOOLS = [
    types.Tool(
        function_declarations=[
            list_files_declaration,
            read_file_declaration,
            run_command_declaration,
        ]
    )
]


# ---------------------------------------------------------
# Gemini configuration
# ---------------------------------------------------------

GENERATE_CONFIG = types.GenerateContentConfig(
    tools=TOOLS,
    automatic_function_calling=types.AutomaticFunctionCallingConfig(
        disable=True
    ),
    system_instruction=(
        "You are a local project assistant. "
        "You have access to local filesystem and read-only terminal "
        "tools. When the user asks about files, directories, or the "
        "project's Git status, use the appropriate tool instead of "
        "guessing. Never claim that you executed a command unless "
        "the tool actually returned its result."
    ),
)


# ---------------------------------------------------------
# Build conversation contents
# ---------------------------------------------------------

def build_contents(msg, history):
    """Convert frontend conversation history into Gemini contents."""

    contents = []

    for item in history:
        role = item.get("role")
        parts = item.get("parts", [])

        if role and parts:
            converted_parts = []

            for part in parts:
                if isinstance(part, dict) and "text" in part:
                    converted_parts.append(
                        types.Part.from_text(
                            text=part["text"]
                        )
                    )
                else:
                    converted_parts.append(part)

            contents.append(
                types.Content(
                    role=role,
                    parts=converted_parts,
                )
            )

    contents.append(
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(
                    text=msg
                )
            ],
        )
    )

    return contents


# ---------------------------------------------------------
# Explicit Gemini tool-calling loop
# ---------------------------------------------------------

def generate_with_tools(contents):
    """Run Gemini and explicitly execute requested tools.

    Flow:

        Gemini
          ↓
        function call
          ↓
        execute local Python function
          ↓
        send function result to Gemini
          ↓
        Gemini generates final response
    """

    max_tool_rounds = 10

    for _ in range(max_tool_rounds):

        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=contents,
            config=GENERATE_CONFIG,
        )

        if not response.candidates:
            return response

        model_content = response.candidates[0].content

        function_calls = []

        for part in model_content.parts:
            if part.function_call:
                function_calls.append(part.function_call)

        # Gemini has produced its final answer.
        if not function_calls:
            return response

        # Preserve Gemini's function-call message.
        contents.append(model_content)

        function_response_parts = []

        for function_call in function_calls:

            function_name = function_call.name
            function_args = dict(function_call.args or {})

            print(
                f"[Gemini tool call] "
                f"{function_name}({function_args})"
            )

            function = TOOL_FUNCTIONS.get(function_name)

            if function is None:
                result = {
                    "error": (
                        f"Unknown tool requested: "
                        f"{function_name}"
                    )
                }

            else:
                try:
                    result = function(**function_args)

                except Exception as exc:
                    result = {
                        "error": (
                            f"Tool {function_name} failed: "
                            f"{exc}"
                        )
                    }

            print(
                f"[Gemini tool result] "
                f"{function_name}: {result}"
            )

            # IMPORTANT:
            # google-genai 2.17.0 does not accept id= here.
            function_response_parts.append(
                types.Part.from_function_response(
                    name=function_name,
                    response={
                        "result": result
                    },
                )
            )

        # Send the actual local tool results back to Gemini.
        contents.append(
            types.Content(
                role="user",
                parts=function_response_parts,
            )
        )

    raise RuntimeError(
        "Gemini exceeded the maximum number of tool-calling rounds."
    )


# ---------------------------------------------------------
# Chat endpoint
# ---------------------------------------------------------

@app.route("/chat", methods=["POST"])
def chat():
    """Process a chat request."""

    data = request.get_json(silent=True) or {}

    msg = data.get("chat", "")
    history = data.get("history", [])

    contents = build_contents(
        msg,
        history,
    )

    response = generate_with_tools(contents)

    return {
        "text": response.text or ""
    }


# ---------------------------------------------------------
# Streaming endpoint
# ---------------------------------------------------------

@app.route("/stream", methods=["POST"])
def stream():
    """Stream the final Gemini response.

    Tool calls are handled explicitly first. Once Gemini has
    finished using tools, the final response is returned.
    """

    def generate():

        data = request.get_json(silent=True) or {}

        msg = data.get("chat", "")
        history = data.get("history", [])

        contents = build_contents(
            msg,
            history,
        )

        max_tool_rounds = 10

        for _ in range(max_tool_rounds):

            response = client.models.generate_content(
                model=MODEL_NAME,
                contents=contents,
                config=GENERATE_CONFIG,
            )

            if not response.candidates:
                return

            model_content = response.candidates[0].content

            function_calls = [
                part.function_call
                for part in model_content.parts
                if part.function_call
            ]

            # Gemini has finished using tools.
            if not function_calls:

                if response.text:
                    yield response.text

                return

            # Preserve Gemini's function-call message.
            contents.append(model_content)

            function_response_parts = []

            for function_call in function_calls:

                function_name = function_call.name
                function_args = dict(function_call.args or {})

                print(
                    f"[Gemini tool call] "
                    f"{function_name}({function_args})"
                )

                function = TOOL_FUNCTIONS.get(function_name)

                if function is None:
                    result = {
                        "error": (
                            f"Unknown tool requested: "
                            f"{function_name}"
                        )
                    }

                else:
                    try:
                        result = function(**function_args)

                    except Exception as exc:
                        result = {
                            "error": (
                                f"Tool {function_name} failed: "
                                f"{exc}"
                            )
                        }

                print(
                    f"[Gemini tool result] "
                    f"{function_name}: {result}"
                )

                # IMPORTANT:
                # google-genai 2.17.0 does not accept id= here.
                function_response_parts.append(
                    types.Part.from_function_response(
                        name=function_name,
                        response={
                            "result": result
                        },
                    )
                )

            contents.append(
                types.Content(
                    role="user",
                    parts=function_response_parts,
                )
            )

        raise RuntimeError(
            "Gemini exceeded the maximum number of tool-calling rounds."
        )

    return Response(
        stream_with_context(generate()),
        mimetype="text/plain",
    )


# ---------------------------------------------------------
# Run Flask
# ---------------------------------------------------------

if __name__ == "__main__":

    port = int(
        os.getenv("PORT", "9000")
    )

    app.run(
        host="127.0.0.1",
        port=port,
    )