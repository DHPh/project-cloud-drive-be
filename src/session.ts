import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request } from 'express';
import type { DataSource } from 'typeorm';
import { ApiError, sessionRequired } from './errors';

const cookieName = 'cloud_drive_session';
const unknownUserHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0000000000000000000000000000000000000000000000000000000000000000';

type User = { id: string; email: string; name: string };
type Credential = User & { password_hash: string };

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt);
  return salt + ':' + key.toString('hex');
}

function cookieFrom(req: Request): string | undefined {
  for (const cookie of req.headers.cookie?.split(';') || []) {
    const [name, token] = cookie.trim().split('=');
    if (name === cookieName && typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      return token;
    }
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash || !/^[0-9a-f]{64}$/.test(hash)) return false;
  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export function createSessions(db: DataSource, ttlMs: number, secure: boolean) {
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/' } satisfies CookieOptions;

  async function login(email: string, password: string, request: Request) {
    const [credential] = await db.query<Credential[]>(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email]
    );
    const passwordValid = await verifyPassword(password, credential?.password_hash ?? unknownUserHash);
    if (!credential || !passwordValid) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
    }

    const token = randomBytes(32).toString('base64url');
    const previous = cookieFrom(request);
    await db.transaction(async (manager) => {
      if (previous) await manager.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(previous)]);
      await manager.query(
        'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
        [tokenHash(token), credential.id, new Date(Date.now() + ttlMs)]
      );
    });

    return { token, user: { id: credential.id, email: credential.email, name: credential.name } };
  }

  async function currentUser(req: Request): Promise<User> {
    const token = cookieFrom(req);
    if (!token) throw sessionRequired();
    const [user] = await db.query<User[]>(`
      SELECT u.id, u.email, u.name
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
    `, [tokenHash(token)]);
    if (!user) throw sessionRequired();
    return user;
  }

  async function logout(req: Request): Promise<void> {
    const token = cookieFrom(req);
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
  }

  return { login, currentUser, logout, cookieName, cookieOptions, ttlMs };
}
