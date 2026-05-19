const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const extensionDir = path.join(rootDir, 'chrome-extension');
const releaseDir = path.join(rootDir, 'release');
const manifestPath = path.join(extensionDir, 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  console.error('manifest.json não encontrado em chrome-extension/.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = String(manifest.version || '').trim();
if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) {
  console.error(`Versão inválida no manifest: ${version}`);
  process.exit(1);
}

fs.mkdirSync(releaseDir, { recursive: true });

const targets = [
  path.join(releaseDir, `WA-PRO-Chrome-Extension-v${version}.zip`),
  path.join(releaseDir, `WA-PRO-Chrome-Extension-Store-v${version}.zip`),
];

for (const target of targets) {
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

const commonArgs = [
  '-qr',
  targets[0],
  '.',
  '-x',
  'README.md',
  'STORE_SUBMISSION.md',
  '*.DS_Store',
];

const result = spawnSync('zip', commonArgs, {
  cwd: extensionDir,
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.error('Falha ao criar ZIP da extensão. Confirma se o comando zip está instalado.');
  process.exit(result.status || 1);
}

fs.copyFileSync(targets[0], targets[1]);
console.log(`Criado: ${targets[0]}`);
console.log(`Criado: ${targets[1]}`);
