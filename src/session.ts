import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request } from 'express';
import type { DataSource } from 'typeorm';
import { ApiError, sessionRequired } from './errors';

const cookieName = 'cloud_drive_session';
const unknownUserHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0000000000000000000000000000000000000000000000000000000000000000';

export type User = { id: string; email: string; name: string; role: 'user' | 'admin' };
type Credential = User & { password_hash: string };

export function publicUser({ id, email, name, role }: User): User {
  return { id, email, name, role };
}

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

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash || !/^[0-9a-f]{64}$/.test(hash)) return false;
  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export function createSessions(db: DataSource, ttlMs: number, secure: boolean) {
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/' } satisfies CookieOptions;

  async function login(email: string, password: string, request: Request) {
    const [credential] = await db.query<Credential[]>(
      'SELECT id, email, name, role, password_hash FROM users WHERE email = $1 AND disabled_at IS NULL',
      [email]
    );
    const passwordValid = await verifyPassword(password, credential?.password_hash ?? unknownUserHash);
    if (!credential || !passwordValid) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
    }

    const token = randomBytes(32).toString('base64url');
    const previous = cookieFrom(request);
    const user = await db.transaction(async (manager) => {
      const [current] = await manager.query<User[]>(`
        SELECT id, email, name, role FROM users WHERE id = $1 AND password_hash = $2 AND disabled_at IS NULL FOR UPDATE
      `, [credential.id, credential.password_hash]);
      if (!current) throw new ApiError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
      if (previous) await manager.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(previous)]);
      await manager.query(
        'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
        [tokenHash(token), current.id, new Date(Date.now() + ttlMs)]
      );
      return current;
    });

    return { token, user };
  }

  async function currentUser(req: Request): Promise<User> {
    const token = cookieFrom(req);
    if (!token) throw sessionRequired();
    const [user] = await db.query<User[]>(`
      SELECT u.id, u.email, u.name, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL
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
