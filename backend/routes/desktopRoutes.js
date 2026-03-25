const fs = require('fs');

function isAllowedBuildName(name) {
    if (!name) return false;
    if (name.includes('/') || name.includes('\\')) return false;
    if (name.includes('..')) return false;
    return /\.(zip|exe|7z)$/i.test(name);
}

function parseSemver(rawVersion) {
    const match = String(rawVersion || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}

function compareSemver(aVersion, bVersion) {
    const a = parseSemver(aVersion);
    const b = parseSemver(bVersion);
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    return 0;
}

function extractVersionFromBuildName(name) {
    const match = String(name || '').match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
}

function registerDesktopRoutes(context) {
    const {
        app,
        path,
        baseDir,
    } = context;

    const releaseDir = path.join(baseDir, 'release');

    app.get('/api/desktop/builds', async (req, res) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            if (!fs.existsSync(releaseDir)) {
                return res.json({ success: true, builds: [] });
            }

            const items = fs.readdirSync(releaseDir, { withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name)
                .filter((name) => /\.(zip|exe|7z)$/i.test(name))
                .map((name) => {
                    const fullPath = path.join(releaseDir, name);
                    const stats = fs.statSync(fullPath);
                    const buildVersion = extractVersionFromBuildName(name);
                    return {
                        name,
                        version: buildVersion,
                        sizeBytes: Number(stats.size || 0),
                        updatedAt: stats.mtime ? stats.mtime.toISOString() : null,
                    };
                })
                .sort((a, b) => {
                    const semverOrder = compareSemver(a.version, b.version);
                    if (semverOrder !== 0) return semverOrder * -1;
                    const aTs = a.updatedAt ? Date.parse(a.updatedAt) : 0;
                    const bTs = b.updatedAt ? Date.parse(b.updatedAt) : 0;
                    return bTs - aTs;
                });

            let appVersion = null;
            try {
                const packageJsonPath = path.join(baseDir, 'package.json');
                if (fs.existsSync(packageJsonPath)) {
                    const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                    const parsed = parseSemver(raw?.version);
                    appVersion = parsed ? raw.version : null;
                }
            } catch (_) {
                appVersion = null;
            }

            const latestBuildVersion = items.find((item) => parseSemver(item.version))?.version || null;
            const hasCurrentBuild = Boolean(
                appVersion && items.some((item) => String(item.version || '') === String(appVersion))
            );

            return res.json({
                success: true,
                appVersion,
                latestBuildVersion,
                hasCurrentBuild,
                builds: items,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error?.message || 'Falha ao listar builds desktop.',
            });
        }
    });

    app.get('/api/desktop/download/:name', async (req, res) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            const rawName = String(req.params.name || '').trim();
            const fileName = path.basename(rawName);

            if (!isAllowedBuildName(fileName) || fileName !== rawName) {
                return res.status(400).json({ success: false, error: 'Nome de ficheiro inválido.' });
            }

            const fullPath = path.join(releaseDir, fileName);
            if (!fs.existsSync(fullPath)) {
                return res.status(404).json({ success: false, error: 'Build não encontrado.' });
            }

            return res.download(fullPath, fileName);
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error?.message || 'Falha ao descarregar build desktop.',
            });
        }
    });
}

module.exports = {
    registerDesktopRoutes,
};
