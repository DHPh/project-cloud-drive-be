import { isIP } from 'node:net';

type Environment = NodeJS.ProcessEnv;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error('Missing environment variable ' + name);
  return value;
}

function integer(env: Environment, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + ' is outside its supported range');
  }
  return value;
}

export function databaseUrl(env: Environment = process.env): string {
  return required(env, 'DATABASE_URL');
}

export function storageConfig(env: Environment = process.env) {
  const endpoint = new URL(required(env, 'S3_ENDPOINT'));
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Invalid S3_ENDPOINT');
  }
  return {
    endpoint: endpoint.href,
    region: env.S3_REGION || 'us-east-1',
    bucket: env.S3_BUCKET || 'cloud-drive-files',
    accessKey: required(env, 'S3_ACCESS_KEY'),
    secretKey: required(env, 'S3_SECRET_KEY'),
  };
}

export function recoveryAgeMs(env: Environment = process.env): number {
  return integer(env, 'UPLOAD_RECOVERY_AGE_SECONDS', 300, 60, 86400) * 1000;
}

function trustedProxyRanges(env: Environment): string[] {
  const ranges = (env.TRUSTED_PROXY_RANGES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  for (const range of ranges) {
    const [address, prefix, extra] = range.split('/');
    const family = isIP(address ?? '');
    const bits = family === 4 ? 32 : 128;
    if (!family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > bits))) {
      throw new Error('TRUSTED_PROXY_RANGES must contain explicit IP addresses or non-global CIDRs');
    }
  }
  return ranges;
}

export function appConfig(env: Environment = process.env) {
  const production = env.NODE_ENV === 'production';
  const rawOrigin = production ? required(env, 'APP_ORIGIN') : env.APP_ORIGIN || 'http://localhost:3000';
  const origin = new URL(rawOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== rawOrigin) {
    throw new Error('APP_ORIGIN must be an HTTP origin without a path or trailing slash');
  }
  const cookieOverride = env.SESSION_COOKIE_SECURE;
  if (cookieOverride !== undefined && cookieOverride !== 'true' && cookieOverride !== 'false') {
    throw new Error('SESSION_COOKIE_SECURE must be true or false');
  }
  const secureCookie = cookieOverride === undefined ? origin.protocol === 'https:' : cookieOverride === 'true';
  if (production && (origin.protocol !== 'https:' || !secureCookie)) {
    throw new Error('Production requires an HTTPS APP_ORIGIN and a Secure session cookie');
  }

  return {
    origin: origin.origin,
    secureCookie,
    trustedProxyRanges: trustedProxyRanges(env),
    sessionTtlMs: integer(env, 'SESSION_TTL_HOURS', 168, 1, 720) * 3600000,
    maxUploadBytes: integer(env, 'MAX_UPLOAD_BYTES', 10485760, 1, 104857600),
    uploadRecoveryAgeMs: recoveryAgeMs(env),
    port: integer(env, 'PORT', 3001, 1, 65535),
    host: env.HOST || '0.0.0.0',
  };
}
