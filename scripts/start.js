import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const serverPath = resolve(root, 'dist/index.js');
const envPath = resolve(root, '.env');
const pidPath = join(root, '.local/server.pid');
const serverArgs = [`--env-file-if-exists=${envPath}`, serverPath];

function belongsToThisServer(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 && result.stdout.includes(serverPath);
  } catch {
    return false;
  }
}

function storedPid() {
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function clearPidFile() {
  try { unlinkSync(pidPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function stop() {
  const pid = storedPid();
  if (!pid || !belongsToThisServer(pid)) {
    clearPidFile();
    console.log('Codex server is not running in the background.');
    return;
  }
  process.kill(pid, 'SIGTERM');
  clearPidFile();
  console.log(`Stopped Codex server (pid ${pid}).`);
}

function foreground() {
  const child = spawn(process.execPath, serverArgs, { cwd: root, env: process.env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = signal === 'SIGINT' ? 130 : code ?? 1; });
}

async function background() {
  const oldPid = storedPid();
  if (oldPid && belongsToThisServer(oldPid)) {
    console.log(`Codex server is already running (pid ${oldPid}).`);
    return;
  }
  clearPidFile();
  mkdirSync(join(root, '.local'), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, serverArgs, { cwd: root, env: process.env, detached: true, stdio: 'ignore' });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('error', rejectSpawn);
    child.once('spawn', () => {
      writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
      child.unref();
      resolveSpawn();
    });
  });
}

if (process.argv.includes('--stop')) await stop();
else if (process.argv.includes('-d')) await background();
else foreground();
