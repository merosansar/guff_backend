import request from 'supertest';
import { Session } from '../src/models/index.js';
import { REFRESH_COOKIE } from '../src/http/routes.js';
import { type TestApp, clearDatabase, createGeneral, startApp } from './helpers.js';

let app: TestApp;
const agent = () => request(app.guff.app);

const setCookies = (res: request.Response): string[] => {
  const value = res.headers['set-cookie'] as unknown;
  return Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [];
};

const cookieFrom = (res: request.Response): string => {
  const raw = setCookies(res);
  const line = raw.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  if (!line) throw new Error('no refresh cookie');
  return line.split(';')[0]!;
};

beforeAll(async () => {
  app = await startApp();
  await clearDatabase();
  await createGeneral();
});
afterAll(() => app.close());

describe('sign up and sign in', () => {
  it('signs up, sets an httpOnly refresh cookie and joins #general', async () => {
    const res = await agent()
      .post('/api/auth/register')
      .send({ name: 'Sita Sharma', email: 'Sita@Example.com', password: 'password123' })
      .expect(201);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.user).toMatchObject({ name: 'Sita Sharma', email: 'sita@example.com' });
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookie = setCookies(res).find((c) => c.startsWith(REFRESH_COOKIE))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);

    const channels = await agent()
      .get('/api/channels')
      .set('authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(channels.body.map((c: { name: string }) => c.name)).toContain('general');
  });

  it('rejects a second account with the same email', async () => {
    const res = await agent()
      .post('/api/auth/register')
      .send({ name: 'Other', email: 'sita@example.com', password: 'password123' })
      .expect(409);
    expect(res.body.message).toBe('That email already has an account. Sign in instead.');
  });

  it('explains what is wrong with the details', async () => {
    const res = await agent()
      .post('/api/auth/register')
      .send({ name: 'A', email: 'nope', password: 'short' })
      .expect(400);
    expect(res.body.message).toBe('Enter your name.');
    const res2 = await agent()
      .post('/api/auth/register')
      .send({ name: 'Anjali', email: 'anjali@example.com', password: 'short' })
      .expect(400);
    expect(res2.body.message).toBe('Use at least 8 characters for your password.');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrong = await agent()
      .post('/api/auth/login')
      .send({ email: 'sita@example.com', password: 'wrong-password' })
      .expect(401);
    const unknown = await agent()
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' })
      .expect(401);
    expect(wrong.body.message).toBe('That email and password don’t match.');
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it('rejects requests without a valid token', async () => {
    await agent().get('/api/channels').expect(401);
    await agent().get('/api/channels').set('authorization', 'Bearer not-a-token').expect(401);
  });
});

describe('refresh tokens', () => {
  it('needs the app header, so a cross-site form can’t use the cookie', async () => {
    const login = await agent()
      .post('/api/auth/login')
      .send({ email: 'sita@example.com', password: 'password123' })
      .expect(200);
    await agent().post('/api/auth/refresh').set('cookie', cookieFrom(login)).expect(403);
  });

  it('rotates the token on every refresh', async () => {
    const login = await agent()
      .post('/api/auth/login')
      .send({ email: 'sita@example.com', password: 'password123' })
      .expect(200);
    const first = cookieFrom(login);
    const refreshed = await agent()
      .post('/api/auth/refresh')
      .set('x-guff-client', 'web')
      .set('cookie', first)
      .expect(200);
    expect(refreshed.body.accessToken).toBeTypeOf('string');
    expect(cookieFrom(refreshed)).not.toBe(first);
  });

  it('lets two tabs refresh with the same token at the same moment', async () => {
    const login = await agent()
      .post('/api/auth/login')
      .send({ email: 'sita@example.com', password: 'password123' })
      .expect(200);
    const cookie = cookieFrom(login);
    const [a, b] = await Promise.all([
      agent().post('/api/auth/refresh').set('x-guff-client', 'web').set('cookie', cookie),
      agent().post('/api/auth/refresh').set('x-guff-client', 'web').set('cookie', cookie),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('treats an old token used again later as stolen and ends every session', async () => {
    const login = await agent()
      .post('/api/auth/login')
      .send({ email: 'sita@example.com', password: 'password123' })
      .expect(200);
    const stolen = cookieFrom(login);
    const fresh = await agent()
      .post('/api/auth/refresh')
      .set('x-guff-client', 'web')
      .set('cookie', stolen)
      .expect(200);
    // Pretend the rotation happened a minute ago, past the grace window.
    await Session.updateMany(
      { replacedBy: { $ne: null } },
      { $set: { revokedAt: new Date(Date.now() - 60_000) } },
    );

    const replay = await agent()
      .post('/api/auth/refresh')
      .set('x-guff-client', 'web')
      .set('cookie', stolen)
      .expect(401);
    expect(replay.body.message).toBe('Your session ended. Sign in again.');
    // The legitimate, newer token is revoked too.
    await agent()
      .post('/api/auth/refresh')
      .set('x-guff-client', 'web')
      .set('cookie', cookieFrom(fresh))
      .expect(401);
  });

  it('logs out by revoking the token', async () => {
    const login = await agent()
      .post('/api/auth/login')
      .send({ email: 'sita@example.com', password: 'password123' })
      .expect(200);
    const cookie = cookieFrom(login);
    await agent()
      .post('/api/auth/logout')
      .set('x-guff-client', 'web')
      .set('cookie', cookie)
      .expect(204);
    await agent()
      .post('/api/auth/refresh')
      .set('x-guff-client', 'web')
      .set('cookie', cookie)
      .expect(401);
  });
});

describe('the rest of the API', () => {
  it('answers health checks and unknown routes', async () => {
    const health = await agent().get('/api/health').expect(200);
    expect(health.body).toMatchObject({ status: 'ok', database: 'up' });
    const missing = await agent().get('/api/nothing-here').expect(404);
    expect(missing.body.message).toBe('There’s nothing at that address.');
  });

  it('sets security headers', async () => {
    const res = await agent().get('/api/health');
    expect(res.get('x-content-type-options')).toBe('nosniff');
    expect(res.get('x-powered-by')).toBeUndefined();
  });

  it('rate-limits sign-in attempts', async () => {
    const strict = await startApp({ AUTH_RATE_LIMIT: '3' });
    try {
      for (let i = 0; i < 3; i++) {
        await request(strict.guff.app)
          .post('/api/auth/login')
          .send({ email: 'x@example.com', password: 'nope-nope' })
          .expect(401);
      }
      const limited = await request(strict.guff.app)
        .post('/api/auth/login')
        .send({ email: 'x@example.com', password: 'nope-nope' })
        .expect(429);
      expect(limited.body.message).toBe('Too many attempts. Wait a few minutes and try again.');
    } finally {
      await strict.close();
    }
  });
});
