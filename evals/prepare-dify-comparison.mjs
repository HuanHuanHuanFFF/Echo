import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';

const [sourceRoot, outArg] = process.argv.slice(2);
assert.ok(sourceRoot && outArg, 'Expected DIFY_SOURCE NEW_DEPLOY_DIR');
const out = path.resolve(outArg);
await fs.mkdir(out);
const dockerRoot = path.join(sourceRoot, 'docker');
const original = await fs.readFile(
  path.join(dockerRoot, 'docker-compose.yaml'),
  'utf8',
);
const upstream = parse(original, { merge: true });
const names = [
  'init_permissions',
  'db_postgres',
  'redis',
  'weaviate',
  'api',
  'worker',
  'plugin_daemon',
];
const services = {};
for (const name of names) {
  const service = structuredClone(upstream.services[name]);
  assert.ok(service, 'Unknown upstream service ' + name);
  delete service.profiles;
  delete service.container_name;
  delete service.ports;
  delete service.networks;
  service.restart = 'no';
  if (service.depends_on) {
    service.depends_on = Object.fromEntries(
      Object.entries(service.depends_on).filter(([dependency]) =>
        names.includes(dependency),
      ),
    );
  }
  // Shared defaults are copied verbatim; the final private env file overrides them.
  if (service.env_file && !service.env_file.includes('./.env'))
    service.env_file.push('./.env');
  if (name === 'api') service.ports = ['127.0.0.1:15101:5001'];
  if (name === 'weaviate') {
    service.environment.DISK_USE_READONLY_PERCENTAGE = '97';
    service.environment.DISK_USE_WARNING_PERCENTAGE = '95';
  }
  services[name] = service;
}
await fs.cp(path.join(dockerRoot, 'envs'), path.join(out, 'envs'), {
  recursive: true,
  errorOnExist: true,
  force: false,
});
const token = () => randomBytes(32).toString('hex');
const dbPassword = token();
const redisPassword = token();
const pluginKey = token();
const innerKey = token();
const vectorKey = token();
const settings = {
  SECRET_KEY: token(),
  DB_TYPE: 'postgresql',
  DB_HOST: 'db_postgres',
  DB_PORT: '5432',
  DB_USERNAME: 'postgres',
  DB_PASSWORD: dbPassword,
  DB_DATABASE: 'dify',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: redisPassword,
  CELERY_BROKER_URL: `redis://:${redisPassword}@redis:6379/1`,
  VECTOR_STORE: 'weaviate',
  WEAVIATE_ENDPOINT: 'http://weaviate:8080',
  WEAVIATE_API_KEY: vectorKey,
  WEAVIATE_AUTHENTICATION_APIKEY_ALLOWED_KEYS: vectorKey,
  WEAVIATE_DISABLE_TELEMETRY: 'true',
  PLUGIN_DAEMON_URL: 'http://plugin_daemon:5002',
  PLUGIN_DAEMON_KEY: pluginKey,
  PLUGIN_DIFY_INNER_API_KEY: innerKey,
  PLUGIN_DIFY_INNER_API_URL: 'http://api:5001',
  FORCE_VERIFYING_SIGNATURE: 'true',
  SERVER_WORKER_AMOUNT: '1',
  CELERY_WORKER_AMOUNT: '1',
  CELERY_AUTO_SCALE: 'false',
  GUNICORN_TIMEOUT: '360',
  SQLALCHEMY_POOL_SIZE: '30',
  SQLALCHEMY_MAX_OVERFLOW: '10',
  ENABLE_OTEL: 'false',
  LOG_LEVEL: 'WARNING',
  CHECK_UPDATE_URL: '',
  CONSOLE_WEB_URL: 'http://127.0.0.1:15101',
  CONSOLE_API_URL: 'http://127.0.0.1:15101',
  APP_WEB_URL: 'http://127.0.0.1:15101',
  APP_API_URL: 'http://127.0.0.1:15101',
  SERVICE_API_URL: 'http://127.0.0.1:15101',
  FILES_URL: 'http://127.0.0.1:15101',
  SSRF_PROXY_HTTP_URL: '',
  SSRF_PROXY_HTTPS_URL: '',
  MIGRATION_ENABLED: 'true',
  STORAGE_TYPE: 'opendal',
  OPENDAL_SCHEME: 'fs',
  OPENDAL_FS_ROOT: 'storage',
};
await fs.writeFile(
  path.join(out, '.env'),
  Object.entries(settings)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n',
  { flag: 'wx', mode: 0o600 },
);
const compose = { name: 'echo-compare-dify', services };
await fs.writeFile(path.join(out, 'compose.yaml'), stringify(compose), {
  flag: 'wx',
});
await fs.writeFile(
  path.join(out, 'deployment-receipt.json'),
  JSON.stringify(
    {
      status: 'prepared-not-started',
      upstream: sourceRoot,
      upstream_compose_sha256: createHash('sha256')
        .update(original)
        .digest('hex'),
      services: names,
      images: Object.fromEntries(
        names.map((name) => [name, services[name].image]),
      ),
      binding: '127.0.0.1:15101',
      adaptations: [
        'only document retrieval services',
        'single API and indexing worker',
        'new isolated data paths',
        'locally generated service credentials',
        'no telemetry',
        'no agent, chat generation, or code execution services',
      ],
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    status: 'prepared-not-started',
    directory: out,
    services: names,
  }),
);
