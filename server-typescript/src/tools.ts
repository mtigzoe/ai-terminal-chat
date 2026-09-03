export interface ToolSchema {
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export type ToolSchemas = Record<string, ToolSchema>;

export const TOOL_SCHEMAS: ToolSchemas = {
  list_files: {
    description:
      "Lists files and directories inside the application project. Use this to explore the project structure before reading or editing files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative directory path inside the project. Use '.' for the project root.",
        },
      },
      required: [],
    },
  },
  read_file: {
    description:
      "Reads a UTF-8 text file inside the application project. Always read a file before editing it.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the text file.",
        },
      },
      required: ["path"],
    },
  },
  search_files: {
    description:
      "Searches text files inside the project for a query string (case-insensitive substring match), returning matching file paths, line numbers, and lines.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for.",
        },
        path: {
          type: "string",
          description:
            "Relative directory to search under. Use '.' for the whole project.",
        },
      },
      required: ["query"],
    },
  },
  run_command: {
    description:
      "Runs one of the explicitly allowed development commands inside the local project directory: read-only git inspection (status, log, diff, branch), directory listings, tool versions, installing dependencies, and running tests/builds/linters. Use this when the user asks you to run the tests, install dependencies, build the project, or check something the dedicated tools don't cover. It cannot run destructive, system-level, or credential-exposing commands.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "An allowed command such as 'pytest', 'npm test', 'npm install', 'git log -n 5', or 'npm run build'.",
        },
      },
      required: ["command"],
    },
  },
  git_status: {
    description:
      "Shows the current git status of the project as plain-language summary and structured fields (clean, staged, ahead/behind, file details). Always call this instead of guessing or assuming the repository state. Use the structured fields to answer questions such as whether changes are committed or whether the branch is synchronized with the remote.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  git_committed_file_count: {
    description:
      "Counts how many files are recorded in the current HEAD commit without modifying the repository. Use when the user asks how many files are committed or tracked in the current commit.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  git_diff: {
    description:
      "Shows the current git diff for the project, or for a single file. Use this to see exactly what has changed before or after making edits.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional relative path to scope the diff to a single file. Leave empty for the whole project.",
        },
        staged: {
          type: "boolean",
          description:
            "If true, show staged changes instead of unstaged changes.",
        },
      },
      required: [],
    },
  },
  git_log: {
    description:
      "Shows recent commit history for the project (one line per commit). Use this to understand recent changes instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        max_count: {
          type: "integer",
          description:
            "Number of commits to show (1-100). Defaults to 10.",
        },
      },
      required: [],
    },
  },
  git_branch: {
    description:
      "Lists local git branches and shows which one is currently checked out.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  git_fetch: {
    description:
      "Fetch changes from a remote repository without merging. Use this to update remote tracking branches before inspecting or pulling.",
    parameters: {
      type: "object",
      properties: {
        remote: {
          type: "string",
          description:
            "Remote name to fetch from. Leave empty for all remotes.",
        },
      },
      required: [],
    },
  },
  git_pull: {
    description:
      "Pull changes from a remote and merge into the current branch. Requires confirmation: calling without confirm=true will NOT pull anything, it only reports what would be pulled. Only call it again with confirm=true after the user has explicitly agreed.",
    parameters: {
      type: "object",
      properties: {
        remote: {
          type: "string",
          description:
            "Remote name. Leave empty for the default remote.",
        },
        branch: {
          type: "string",
          description:
            "Branch to pull. Leave empty for the current branch.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually pull. Defaults to false.",
        },
      },
      required: [],
    },
  },
  git_restore: {
    description:
      "Restore a file to its state in HEAD (or unstage it if staged=true). Requires confirmation: calling without confirm=true will NOT restore anything, it only reports what would be restored. Only call it again with confirm=true after the user has explicitly agreed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to restore.",
        },
        staged: {
          type: "boolean",
          description:
            "If true, unstage the file instead of restoring working tree changes.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually restore the file. Defaults to false.",
        },
      },
      required: ["path"],
    },
  },
  git_commit: {
    description:
      "Commit staged changes with a message. Requires confirmation: calling without confirm=true will NOT commit anything, it only previews the staged diff and reports what would be committed. Only call it again with confirm=true after the user has explicitly agreed.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Commit message.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually create the commit. Defaults to false.",
        },
      },
      required: ["message"],
    },
  },
  git_push: {
    description:
      "Push commits to a remote repository. Requires confirmation: calling without confirm=true will NOT push anything, it only reports what would be pushed. Only call it again with confirm=true after the user has explicitly agreed.",
    parameters: {
      type: "object",
      properties: {
        remote: {
          type: "string",
          description: "Remote name. Leave empty for the default remote.",
        },
        branch: {
          type: "string",
          description: "Branch to push. Leave empty for the current branch.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually push. Defaults to false.",
        },
      },
      required: [],
    },
  },
  create_file: {
    description:
      "Creates a new file with the given contents inside the local project. Fails if the file already exists — use write_file to modify an existing file instead. Requires confirmation: calling without confirm=true will NOT create anything, it only returns a preview. Only call it again with confirm=true after the user has explicitly agreed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path for the new file.",
        },
        contents: {
          type: "string",
          description: "Text contents to write to the file.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually create the file. Defaults to false.",
        },
      },
      required: ["path", "contents"],
    },
  },
  write_file: {
    description:
      "Overwrites an existing file (or creates it if missing) with new contents inside the local project. Read the file first with read_file so you don't discard unrelated user changes, and prefer apply_patch for a small, targeted change instead of rewriting the whole file. Requires confirmation: calling without confirm=true will NOT write anything, it only returns a diff preview. Only call it again with confirm=true after the user has explicitly agreed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file.",
        },
        contents: {
          type: "string",
          description: "The complete new contents of the file.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually write the file. Defaults to false.",
        },
      },
      required: ["path", "contents"],
    },
  },
  apply_patch: {
    description:
      "Applies a small, targeted unified diff (like `git diff` output) to one or more project files. This is the preferred way to make a focused change to an existing file instead of rewriting it entirely with write_file. Requires confirmation: calling without confirm=true will NOT apply anything, it only validates the patch and reports which files would change. Only call it again with confirm=true after the user has explicitly agreed.",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "The unified diff text, including '--- a/<path>' / '+++ b/<path>' headers and '@@ ... @@' hunks.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually apply the patch. Defaults to false.",
        },
      },
      required: ["patch"],
    },
  },
  delete_file: {
    description:
      "Deletes a single file inside the local project. This is destructive. Calling it without confirm=true will NOT delete anything — it only returns what would be deleted. Only call it again with confirm=true after the user has explicitly agreed to the deletion in the conversation.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to delete.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually perform the deletion. Defaults to false.",
        },
      },
      required: ["path"],
    },
  },
  git_add: {
    description:
      "Stages a single file's current changes for the next commit (git add). This only updates the git index — it does not commit, push, or change any file's contents. There is no git_commit or git_push tool, and no other tool can commit or push either — those actions are not available. Requires confirmation: calling without confirm=true will NOT stage anything, it only reports what would be staged. Only call it again with confirm=true after the user has explicitly agreed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to stage.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually stage the file. Defaults to false.",
        },
      },
      required: ["path"],
    },
  },
};

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export function buildToolSchemas(): ToolDefinition[] {
  return Object.entries(TOOL_SCHEMAS).map(([name, schema]) => ({
    type: "function",
    function: {
      name,
      description: schema.description,
      parameters: schema.parameters,
    },
  }));
}
