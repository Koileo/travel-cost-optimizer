// 本地开发服务器复用生产 Vercel handler，避免两套代理和静态服务逻辑漂移。
const fs = require('fs');
const http = require('http');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnvFile();
const handler = require('./app');
const port = Number(process.env.PORT) || 3000;
const server = http.createServer(handler);

server.on('error', error => {
  console.error(`开发服务器无法启动: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, () => console.log(`🚕 出行成本优化器已启动: http://localhost:${port}`));
