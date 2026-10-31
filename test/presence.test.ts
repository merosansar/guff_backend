import { SignJWT } from 'jose';
import { io as connect } from 'socket.io-client';
import { User } from '../src/models/index.js';
import {
  TEST_SECRET,
  type TestApp,
  type TestUser,
  clearDatabase,
  closeSockets,
  connectSocket,
  createGeneral,
  emitOk,
  makeUser,
  sleep,
  startApp,
  waitFor,
} from './helpers.js';

type PresenceEvent = { userId: string; status: string; lastSeenAt: string | null };

let app: TestApp;
let watcher: TestUser;
let sita: TestUser;

beforeAll(async () => {
  app = await startApp();
  await clearDatabase();
  await createGeneral();
  watcher = await makeUser(app, 'Watcher');
  sita = await makeUser(app, 'Sita');
});
afterEach(() => closeSockets());
afterAll(() => app.close());

describe('presence', () => {
  it('goes online with the first tab and offline when the last one closes', async () => {
    const watch = await connectSocket(app, watcher.token);
    const online = waitFor<PresenceEvent>(
      watch,
      'presence',
      (e) => e.userId === sita.id && e.status === 'online',
    );
    const tab1 = await connectSocket(app, sita.token);
    await online;
    const tab2 = await connectSocket(app, sita.token);

    // Closing one of two tabs keeps Sita online.
    const stillOnline = waitFor<PresenceEvent>(watch, 'presence', (e) => e.userId === sita.id);
    tab1.disconnect();
    expect((await stillOnline).status).toBe('online');

    const offline = waitFor<PresenceEvent>(
      watch,
      'presence',
      (e) => e.userId === sita.id && e.status === 'offline',
    );
    tab2.disconnect();
    const event = await offline;
    expect(event.lastSeenAt).not.toBeNull();
    const saved = await User.findById(sita.id).lean();
    expect(saved!.lastSeenAt).not.toBeNull();
  });

  it('shows away once every tab is idle', async () => {
    const watch = await connectSocket(app, watcher.token);
    const tab = await connectSocket(app, sita.token);
    const away = waitFor<PresenceEvent>(
      watch,
      'presence',
      (e) => e.userId === sita.id && e.status === 'away',
    );
    await emitOk(tab, 'presence:idle', { idle: true });
    await away;
    const back = waitFor<PresenceEvent>(
      watch,
      'presence',
      (e) => e.userId === sita.id && e.status === 'online',
    );
    await emitOk(tab, 'presence:idle', { idle: false });
    await back;
  });

  it('lists who is online', async () => {
    await connectSocket(app, sita.token);
    const people = await app.guff.services.people.list();
    expect(people.find((p) => p.id === sita.id)?.status).toBe('online');
    expect(people.find((p) => p.id === watcher.id)?.status).toBe('offline');
  });
});

describe('socket sign-in', () => {
  it('refuses a connection without a valid token', async () => {
    await expect(connectSocket(app, 'nonsense-token')).rejects.toThrow('unauthorized');
    const socket = connect(app.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    const error = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
    expect(error.message).toBe('unauthorized');
    socket.disconnect();
  });

  it('closes the socket when the access token expires, unless the browser renews it', async () => {
    const shortToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sita.id)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
      .sign(new TextEncoder().encode(TEST_SECRET));

    const renewed = await connectSocket(app, shortToken);
    const expiring = await connectSocket(app, shortToken);
    await emitOk(renewed, 'auth:renew', { token: sita.token });

    const expired = waitFor(expiring, 'auth:expired', () => true, 4000);
    await expired;
    await sleep(200);
    expect(expiring.connected).toBe(false);
    expect(renewed.connected).toBe(true);
  });

  it('won’t renew with someone else’s token', async () => {
    const socket = await connectSocket(app, sita.token);
    const ack = await socket.timeout(3000).emitWithAck('auth:renew', { token: watcher.token });
    expect(ack).toEqual({
      ok: false,
      error: { status: 401, message: 'That token belongs to someone else.' },
    });
  });
});
