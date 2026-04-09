import { spawn } from 'node:child_process';

const args = ['vercel', 'dev', '--yes', '--local', '--listen', '127.0.0.1:3000', ...process.argv.slice(2)];
const child = spawn('npx', args, { stdio: 'inherit', shell: false });

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
