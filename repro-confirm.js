const http = require('http');
const { execSync } = require('child_process');

const BASE = 'http://localhost:9000';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log(`[client][${path}] status=${res.status} data=${JSON.stringify(json).slice(0, 1000)}`);
          resolve({ status: res.status, data: json });
        } catch {
          console.log(`[client][${path}] status=${res.status} data=${data.slice(0, 1000)}`);
          resolve({ status: res.status, data: data });
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  // First, stage a file so git_commit has staged changes
  console.log('[setup] Staging a file for commit...');
  try {
    execSync('git add repro-confirm.js', { cwd: 'C:\\Users\\Miriam\\Personal_Coding\\terminal_web_app\\experiments\\version_5\\ai-terminal-chat', stdio: 'ignore' });
    console.log('[setup] File staged successfully');
  } catch (e) {
    console.log('[setup] Could not stage file:', e.message);
  }

  // Do NOT send allowed_paths so the server doesn't restrict gitDiff
  console.log('[client][step1] POST /chat with git commit -m "Hello13"');
  const chatRes = await post('/chat', {
    chat: 'git commit -m "Hello13"',
    history: [],
    request_id: 'diag-' + Date.now(),
    // allowed_paths omitted intentionally
  });

  const toolActivity = chatRes.data.tool_activity || [];
  const pending = toolActivity.find((item) => item.type === 'pending_confirmation');

  if (!pending) {
    console.log('[client][FAIL] No pending_confirmation found in response');
    console.log('[client][tool_activity]', JSON.stringify(toolActivity, null, 2).slice(0, 3000));
    process.exit(1);
  }

  const actionId = pending.action_id;
  console.log(`[client][step2] Found pending_confirmation action_id="${actionId}" tool="${pending.name}"`);

  console.log(`[client][step3] POST /confirm action_id="${actionId}" confirmed=true`);
  const confirmRes = await post('/confirm', {
    action_id: actionId,
    confirmed: true,
    request_id: 'diag-confirm-' + Date.now(),
  });

  console.log('[client][step4] Done');
}

main().catch((err) => {
  console.error('[client][FATAL]', err);
  process.exit(1);
});
