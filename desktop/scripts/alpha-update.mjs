import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const host = '127.0.0.1';
const localPort = 47829;
const ciPort = 47830;
const versions = ['0.0.1', '0.0.2'];
const archiveName = 'Visarium-Alpha.app.tar.gz';

function run(command, args, { cwd = repo, env = process.env, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: quiet ? ['ignore', 'ignore', 'ignore'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function generateCertificate(directory) {
  const caConfig = `[req]
prompt = no
distinguished_name = name
x509_extensions = ca
[name]
CN = Visarium Alpha Feed CA
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
`;
  const leafConfig = `subjectAltName = IP:${host}
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
`;
  writeFileSync(join(directory, 'ca.cnf'), caConfig);
  writeFileSync(join(directory, 'feed.cnf'), leafConfig);
  const openssl = (args) => run('openssl', args, { cwd: directory, quiet: true });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '30',
    '-config',
    'ca.cnf',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
  ]);
  openssl([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=Visarium Alpha Feed',
    '-keyout',
    'feed.key',
    '-out',
    'feed.csr',
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    'feed.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '30',
    '-extfile',
    'feed.cnf',
    '-out',
    'feed.pem',
  ]);
}

function prepare(directory) {
  const privateDir = join(directory, 'private');
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  generateCertificate(privateDir);
  chmodSync(join(privateDir, 'ca.key'), 0o600);
  chmodSync(join(privateDir, 'feed.key'), 0o600);
}

function build(output, notarized = false) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('Build the Visarium alpha pair on an Apple Silicon or Intel Mac.');
  }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = `${arch}-apple-darwin`;
  const home = join(repo, 'target', 'alpha-update');
  mkdirSync(home, { recursive: true });
  const directory = output ?? mkdtempSync(join(home, 'rehearsal-'));
  const appName = notarized ? 'Visarium Alpha CI' : 'Visarium Alpha';
  const feedUrl = `https://${host}:${notarized ? ciPort : localPort}`;
  const privateDir = join(directory, 'private');
  const feed = join(directory, 'feed');
  const baseline = join(directory, 'baseline');
  const install = join(directory, 'install');
  for (const path of [privateDir, feed, baseline, install])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  console.log(`Alpha workspace: ${directory}`);
  const signing = {};
  if (notarized) {
    const ca = Buffer.from(process.env.VISARIUM_ALPHA_FEED_CA ?? '', 'base64').toString('utf8');
    if (!ca.startsWith('-----BEGIN CERTIFICATE-----'))
      throw new Error('A public feed CA is required.');
    writeFileSync(join(privateDir, 'ca.pem'), ca);
    for (const name of [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
    ]) {
      const value = process.env[name];
      if (!value) throw new Error(`Missing ${name}`);
      signing[name] = value;
    }
  } else {
    prepare(directory);
    signing.APPLE_SIGNING_IDENTITY = '-';
  }

  // Keep test signing credentials separate from the release signing environment.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith('APPLE_') && !name.startsWith('TAURI_SIGNING_') && name !== 'TAURI_CONFIG',
    ),
  );
  env.CARGO_TARGET_DIR = join(home, 'cargo');
  const privateKey = join(privateDir, 'updater.key');
  const password = randomBytes(24).toString('hex');
  run(
    'pnpm',
    [
      'exec',
      'tauri',
      'signer',
      'generate',
      '--ci',
      '--password',
      password,
      '--write-keys',
      privateKey,
    ],
    { env, quiet: true },
  );
  const publicKey = readFileSync(`${privateKey}.pub`, 'utf8').trim();
  const bundle = join(env.CARGO_TARGET_DIR, target, 'release', 'bundle', 'macos', `${appName}.app`);
  const overlay = join(privateDir, 'tauri.json');
  const app = join(install, `${appName}.app`);
  const baselineApp = join(baseline, `${appName}.app`);

  for (const version of versions) {
    writeFileSync(
      overlay,
      JSON.stringify({
        productName: appName,
        identifier: notarized ? 'dev.visarium.desktop.alpha.ci' : 'dev.visarium.desktop.alpha',
        version,
        bundle: {
          createUpdaterArtifacts: true,
          resources: { [join(privateDir, 'ca.pem')]: 'alpha-feed.pem' },
        },
        plugins: {
          updater: {
            endpoints: [`${feedUrl}/latest.json`],
            pubkey: publicKey,
            requireSignedVersion: true,
          },
        },
      }),
    );
    const options = [
      '--ci',
      '--target',
      target,
      '--features',
      'alpha-updater',
      '--config',
      overlay,
    ];
    run('pnpm', ['run', 'desktop:build', ...options, '--no-bundle', '--', '--locked'], { env });
    run('pnpm', ['exec', 'tauri', 'bundle', ...options, '--bundles', 'app'], {
      env: {
        ...env,
        ...signing,
        TAURI_SIGNING_PRIVATE_KEY: privateKey,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
      },
    });
    if (notarized) {
      run('codesign', ['--verify', '--deep', '--strict', bundle], { env });
      run('xcrun', ['stapler', 'validate', bundle], { env });
      const signature = spawnSync('codesign', ['--display', '--verbose=4', bundle], {
        encoding: 'utf8',
        env,
      });
      if (
        signature.status !== 0 ||
        !/^Authority=Developer ID Application:/m.test(signature.stderr)
      ) {
        throw new Error('Expected a Developer ID Application signature.');
      }
      console.log(`Verified Developer ID and stapled notarization for ${version}.`);
    }
    if (version === versions[0]) {
      if (notarized) {
        run(
          'ditto',
          ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, join(directory, 'baseline.zip')],
          { env },
        );
      } else {
        run('ditto', [bundle, baselineApp], { env });
        run('ditto', [baselineApp, app], { env });
      }
    }
  }

  copyFileSync(`${bundle}.tar.gz`, join(feed, archiveName));
  writeFileSync(
    join(feed, 'latest.json'),
    JSON.stringify({
      version: versions[1],
      platforms: {
        [`darwin-${arch}`]: {
          url: `${feedUrl}/${archiveName}`,
          signature: readFileSync(`${bundle}.tar.gz.sig`, 'utf8').trim(),
        },
      },
    }),
  );
  if (!notarized) {
    console.log(`Start the alpha feed: node desktop/scripts/alpha-update.mjs serve "${directory}"`);
    console.log(`Open "${app}" and choose Settings → About → Check for Updates.`);
  }
}

function serve(directory, port) {
  const feedUrl = `https://${host}:${port}`;
  const routes = new Map([
    ['/latest.json', { name: 'latest.json', type: 'application/json' }],
    [`/${archiveName}`, { name: archiveName, type: 'application/gzip' }],
  ]);
  const server = createServer(
    {
      key: readFileSync(join(directory, 'private', 'feed.key')),
      cert: readFileSync(join(directory, 'private', 'feed.pem')),
    },
    (request, response) => {
      const route = routes.get(request.url);
      if (request.method !== 'GET' || !route) {
        response.writeHead(404).end();
        return;
      }
      const path = join(directory, 'feed', route.name);
      let size;
      try {
        size = statSync(path).size;
      } catch {
        response.writeHead(404).end();
        return;
      }
      console.log(`GET ${request.url}`);
      response.writeHead(200, {
        'Content-Type': route.type,
        'Content-Length': size,
        'Cache-Control': 'no-store',
      });
      createReadStream(path)
        .on('error', () => response.destroy())
        .pipe(response);
    },
  );
  server.listen(port, host, () => console.log(`Alpha feed: ${feedUrl}/latest.json`));
}

const [mode, directory] = process.argv.slice(2);
if (mode === 'build' && !directory) build();
else if (mode === 'prepare' && directory) prepare(resolve(directory));
else if (mode === 'build-notarized' && directory) build(resolve(directory), true);
else if (mode === 'serve' && directory) serve(resolve(directory), localPort);
else if (mode === 'serve-notarized' && directory) serve(resolve(directory), ciPort);
else {
  console.error(
    'Usage: node desktop/scripts/alpha-update.mjs build | {prepare,build-notarized,serve,serve-notarized} <alpha-directory>',
  );
  process.exitCode = 1;
}
