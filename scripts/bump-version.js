#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockPath = path.join(rootDir, 'package-lock.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function parseSemver(version) {
  const match = String(version || '')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`Versão inválida: "${version}"`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function bumpVersion(version, bumpType) {
  const parsed = parseSemver(version);
  if (bumpType === 'major') {
    return `${parsed.major + 1}.0.0`;
  }
  if (bumpType === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function normalizeBumpType(raw) {
  const value = String(raw || 'patch')
    .trim()
    .toLowerCase();
  if (value === 'major' || value === 'minor' || value === 'patch') return value;
  throw new Error(`Tipo de bump inválido: "${raw}". Use major|minor|patch.`);
}

function main() {
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error('package.json não encontrado.');
  }

  const bumpType = normalizeBumpType(process.argv[2] || 'patch');
  const packageJson = readJson(packageJsonPath);
  const currentVersion = String(packageJson.version || '').trim();
  if (!currentVersion) {
    throw new Error('Campo "version" vazio no package.json.');
  }

  const nextVersion = bumpVersion(currentVersion, bumpType);
  packageJson.version = nextVersion;
  writeJson(packageJsonPath, packageJson);

  let lockUpdated = false;
  if (fs.existsSync(packageLockPath)) {
    const packageLock = readJson(packageLockPath);
    if (String(packageLock.version || '').trim() !== nextVersion) {
      packageLock.version = nextVersion;
      lockUpdated = true;
    }
    if (packageLock.packages && packageLock.packages['']) {
      if (String(packageLock.packages[''].version || '').trim() !== nextVersion) {
        packageLock.packages[''].version = nextVersion;
        lockUpdated = true;
      }
    }
    if (lockUpdated) {
      writeJson(packageLockPath, packageLock);
    }
  }

  console.log(`[version] ${currentVersion} -> ${nextVersion} (${bumpType})`);
}

try {
  main();
} catch (error) {
  console.error(`[version] Erro: ${error?.message || error}`);
  process.exit(1);
}

