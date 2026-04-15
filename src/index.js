/**
 * Codex App Server — minimal entrypoint
 *
 * This is a skeleton server for the reference architecture.
 * Replace with your actual Codex App Server implementation.
 *
 * Key env vars:
 *   CODEX_SKILLS_DIR     - path to mounted skills ConfigMap (default: /skills)
 *   SPIFFE_ENDPOINT_SOCKET - SPIRE Workload API socket path
 *   OPENAI_API_KEY_FILE  - path to mounted secret file containing OpenAI API key
 *   PORT                 - HTTP port (default: 8080)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const SKILLS_DIR = process.env.CODEX_SKILLS_DIR || '/skills';

// Read OpenAI API key from mounted secret file (CKV_K8S_35 compliant)
function getApiKey() {
  const keyFile = process.env.OPENAI_API_KEY_FILE;
  if (keyFile && fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }
  return null;
}

// Discover skills from the mounted ConfigMap directory
function discoverSkills() {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    return fs.readdirSync(SKILLS_DIR)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.json'))
      .map(f => path.basename(f, path.extname(f)));
  } catch {
    return [];
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.url === '/readyz') {
    const skills = discoverSkills();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ready', skills }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  const skills = discoverSkills();
  console.log(JSON.stringify({
    level: 'info',
    msg: 'Codex App Server started',
    port: PORT,
    skills_dir: SKILLS_DIR,
    skills_discovered: skills,
    spiffe_socket: process.env.SPIFFE_ENDPOINT_SOCKET || 'not set',
  }));
});
