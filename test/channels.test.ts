import request from 'supertest';
import { Channel, Message } from '../src/models/index.js';
import {
  type TestApp,
  type TestUser,
  bearer,
  clearDatabase,
  closeSockets,
  connectSocket,
  createGeneral,
  emitOk,
  makeUser,
  startApp,
  waitFor,
} from './helpers.js';

let app: TestApp;
let aarav: TestUser;
let sita: TestUser;
let bikash: TestUser;
const api = () => request(app.guff.app);

beforeAll(async () => {
  app = await startApp();
  await clearDatabase();
  await createGeneral();
  aarav = await makeUser(app, 'Aarav');
  sita = await makeUser(app, 'Sita');
  bikash = await makeUser(app, 'Bikash');
});
afterEach(() => closeSockets());
afterAll(() => app.close());

describe('channels', () => {
  it('creates a channel with a clean name and the creator as owner', async () => {
    const res = await api()
      .post('/api/channels')
      .set(bearer(aarav))
      .send({ name: 'Launch Plan 2.0!', topic: 'Shipping soon' })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'launch-plan-20',
      kind: 'public',
      role: 'owner',
      memberCount: 1,
      joined: true,
    });
    const system = await Message.findOne({ channelId: res.body.id, kind: 'system' }).lean();
    expect(system?.text).toBe('created #launch-plan-20');
  });

  it('refuses a duplicate name', async () => {
    const res = await api()
      .post('/api/channels')
      .set(bearer(sita))
      .send({ name: 'launch plan 20' })
      .expect(409);
    expect(res.body.message).toBe('There’s already a channel called #launch-plan-20.');
  });

  it('keeps private channels invisible to people outside them', async () => {
    const created = await api()
      .post('/api/channels')
      .set(bearer(aarav))
      .send({ name: 'hiring', kind: 'private', memberIds: [sita.id] })
      .expect(201);
    expect(created.body.memberCount).toBe(2);

    const browse = await api().get('/api/channels/browse').set(bearer(bikash)).expect(200);
    expect(browse.body.map((c: { name: string }) => c.name)).not.toContain('hiring');
    // 404, not 403: outsiders can't even confirm it exists.
    await api().get(`/api/channels/${created.body.id}`).set(bearer(bikash)).expect(404);
    await api().get(`/api/channels/${created.body.id}/messages`).set(bearer(bikash)).expect(404);
    await api().post(`/api/channels/${created.body.id}/join`).set(bearer(bikash)).expect(404);
    await api().get(`/api/channels/${created.body.id}`).set(bearer(sita)).expect(200);
  });

  it('lets anyone preview a public channel, but only members post', async () => {
    const channel = await Channel.findOne({ name: 'launch-plan-20' }).lean();
    const preview = await api()
      .get(`/api/channels/${channel!._id}/messages`)
      .set(bearer(bikash))
      .expect(200);
    expect(preview.body.messages.length).toBeGreaterThan(0);
    const post = await api()
      .post(`/api/channels/${channel!._id}/messages`)
      .set(bearer(bikash))
      .send({ text: 'hi' })
      .expect(403);
    expect(post.body.message).toBe('Join #launch-plan-20 to take part.');
  });

  it('joins a public channel: the socket joins the room and members hear about it', async () => {
    const channel = await Channel.findOne({ name: 'launch-plan-20' }).lean();
    const id = channel!._id.toString();
    const aaravSocket = await connectSocket(app, aarav.token);
    const bikashSocket = await connectSocket(app, bikash.token);

    const meta = waitFor<{ id: string; memberCount: number }>(
      aaravSocket,
      'channel:meta',
      (m) => m.id === id,
    );
    const upsert = waitFor<{ id: string; joined: boolean }>(
      bikashSocket,
      'channel:upsert',
      (c) => c.id === id,
    );
    await api().post(`/api/channels/${id}/join`).set(bearer(bikash)).expect(200);
    expect((await meta).memberCount).toBe(2);
    expect((await upsert).joined).toBe(true);

    // Without reconnecting, Bikash's open tab now gets the channel's messages.
    const arrived = waitFor<{ text: string }>(
      bikashSocket,
      'message:new',
      (m) => m.text === 'Welcome!',
    );
    await emitOk(aaravSocket, 'message:send', { channelId: id, text: 'Welcome!' });
    await arrived;
  });

  it('leaves a channel, but never #general or a DM', async () => {
    const channel = await Channel.findOne({ name: 'launch-plan-20' }).lean();
    await api().post(`/api/channels/${channel!._id}/leave`).set(bearer(bikash)).expect(204);
    const after = await Channel.findById(channel!._id).lean();
    expect(after!.memberCount).toBe(1);

    const general = await Channel.findOne({ name: 'general' }).lean();
    const res = await api()
      .post(`/api/channels/${general!._id}/leave`)
      .set(bearer(bikash))
      .expect(400);
    expect(res.body.message).toBe(
      'Everyone stays in #general, so announcements reach the whole team.',
    );

    const dm = await api()
      .post('/api/dms')
      .set(bearer(aarav))
      .send({ userId: bikash.id })
      .expect(200);
    await api().post(`/api/channels/${dm.body.id}/leave`).set(bearer(aarav)).expect(400);
  });

  it('only the owner renames; any member sets the topic', async () => {
    const channel = await Channel.findOne({ name: 'hiring' }).lean();
    const id = channel!._id.toString();
    const rename = await api()
      .patch(`/api/channels/${id}`)
      .set(bearer(sita))
      .send({ name: 'recruiting' })
      .expect(403);
    expect(rename.body.message).toBe('Only the channel’s owner and admins can rename it.');
    const topic = await api()
      .patch(`/api/channels/${id}`)
      .set(bearer(sita))
      .send({ topic: 'Backend role' })
      .expect(200);
    expect(topic.body.topic).toBe('Backend role');
    const line = await Message.findOne({ channelId: id, kind: 'system' }).sort({ _id: -1 }).lean();
    expect(line!.text).toBe('set the topic: Backend role');
  });

  it('adds people to a private channel and tells them', async () => {
    const channel = await Channel.findOne({ name: 'hiring' }).lean();
    const id = channel!._id.toString();
    const bikashSocket = await connectSocket(app, bikash.token);
    const upsert = waitFor<{ id: string }>(bikashSocket, 'channel:upsert', (c) => c.id === id);
    const res = await api()
      .post(`/api/channels/${id}/members`)
      .set(bearer(aarav))
      .send({ userIds: [bikash.id] })
      .expect(200);
    expect(res.body.memberCount).toBe(3);
    await upsert;
    const line = await Message.findOne({ channelId: id, kind: 'system' }).sort({ _id: -1 }).lean();
    expect(line!.text).toBe(`added <@${bikash.id}>`);
    expect(line!.mentions.map(String)).toEqual([bikash.id]);
  });
});

describe('direct messages', () => {
  it('opens one DM per pair, even when both open it at once', async () => {
    const [a, b] = await Promise.all([
      api().post('/api/dms').set(bearer(sita)).send({ userId: bikash.id }),
      api().post('/api/dms').set(bearer(bikash)).send({ userId: sita.id }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.id).toBe(b.body.id);
    expect(a.body.dmUserId).toBe(bikash.id);
    expect(b.body.dmUserId).toBe(sita.id);
    expect(await Channel.countDocuments({ kind: 'dm', _id: a.body.id })).toBe(1);
  });

  it('shows an empty DM only to the person who opened it, until someone writes', async () => {
    const dm = await api()
      .post('/api/dms')
      .set(bearer(aarav))
      .send({ userId: sita.id })
      .expect(200);
    const sitasList = await api().get('/api/channels').set(bearer(sita)).expect(200);
    expect(sitasList.body.map((c: { id: string }) => c.id)).not.toContain(dm.body.id);
    const aaravsList = await api().get('/api/channels').set(bearer(aarav)).expect(200);
    expect(aaravsList.body.map((c: { id: string }) => c.id)).toContain(dm.body.id);

    await api()
      .post(`/api/channels/${dm.body.id}/messages`)
      .set(bearer(aarav))
      .send({ text: 'Namaste' })
      .expect(201);
    const after = await api().get('/api/channels').set(bearer(sita)).expect(200);
    const entry = after.body.find((c: { id: string }) => c.id === dm.body.id);
    expect(entry).toMatchObject({ unread: 1, dmUserId: aarav.id });
  });

  it('supports a DM to yourself, for notes', async () => {
    const dm = await api().post('/api/dms').set(bearer(sita)).send({ userId: sita.id }).expect(200);
    expect(dm.body).toMatchObject({ dmUserId: sita.id, memberCount: 1 });
  });
});
