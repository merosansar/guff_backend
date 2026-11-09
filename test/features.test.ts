import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { Channel, Membership, Message, Scheduled } from '../src/models/index.js';
import type { CallInvite, ChannelDto, MessageDto, ThreadDto } from '../src/services/dto.js';
import { memoryMailer } from '../src/services/mail.js';
import {
  type TestApp,
  type TestUser,
  bearer,
  clearDatabase,
  clientId,
  closeSockets,
  connectSocket,
  createGeneral,
  emit,
  emitOk,
  makeUser,
  sleep,
  startApp,
  waitFor,
} from './helpers.js';

let app: TestApp;
const mailer = memoryMailer();
let aarav: TestUser;
let sita: TestUser;
let bikash: TestUser;
let generalId: string;
let aaravSocket: Socket;
let sitaSocket: Socket;
const api = () => request(app.guff.app);

const send = (socket: Socket, channelId: string, text: string, extra: Record<string, unknown> = {}) =>
  emitOk<MessageDto>(socket, 'message:send', { channelId, clientId: clientId(), text, ...extra });

async function channelOf(user: TestUser, id: string): Promise<ChannelDto> {
  const res = await api().get(`/api/channels/${id}`).set(bearer(user)).expect(200);
  return res.body as ChannelDto;
}

beforeAll(async () => {
  app = await startApp({}, { mailer });
  await clearDatabase();
  generalId = (await createGeneral())._id.toString();
  aarav = await makeUser(app, 'Aarav');
  sita = await makeUser(app, 'Sita');
  bikash = await makeUser(app, 'Bikash');
});
beforeEach(async () => {
  aaravSocket = await connectSocket(app, aarav.token);
  sitaSocket = await connectSocket(app, sita.token);
});
afterEach(() => closeSockets());
afterAll(() => app.close());

describe('pins', () => {
  it('pins for everyone, lists pins, and unpins', async () => {
    const m = await send(aaravSocket, generalId, 'Release checklist is in the wiki');
    const updated = waitFor<MessageDto>(sitaSocket, 'message:updated', (u) => u.id === m.id && !!u.pinnedAt);
    await api().post(`/api/messages/${m.id}/pin`).set(bearer(sita)).send({ pinned: true }).expect(200);
    expect((await updated).pinnedBy).toBe(sita.id);
    const pins = await api().get(`/api/channels/${generalId}/pins`).set(bearer(aarav)).expect(200);
    expect(pins.body.map((p: MessageDto) => p.id)).toContain(m.id);
    await api().post(`/api/messages/${m.id}/pin`).set(bearer(aarav)).send({ pinned: false }).expect(200);
    const after = await api().get(`/api/channels/${generalId}/pins`).set(bearer(aarav)).expect(200);
    expect(after.body.map((p: MessageDto) => p.id)).not.toContain(m.id);
  });
});

describe('saved messages', () => {
  it('saves privately, tells your other tabs, and forgets deleted messages', async () => {
    const m = await send(sitaSocket, generalId, 'Budget numbers: see the sheet');
    const otherTab = await connectSocket(app, aarav.token);
    const told = waitFor<{ messageId: string; saved: boolean }>(otherTab, 'bookmark:changed');
    await api().put(`/api/messages/${m.id}/bookmark`).set(bearer(aarav)).send({ saved: true }).expect(200);
    expect(await told).toEqual({ messageId: m.id, saved: true });
    const mine = await api().get('/api/bookmarks').set(bearer(aarav)).expect(200);
    expect(mine.body[0].message.id).toBe(m.id);
    const theirs = await api().get('/api/bookmarks').set(bearer(sita)).expect(200);
    expect(theirs.body).toHaveLength(0);
    await emitOk(sitaSocket, 'message:delete', { messageId: m.id });
    const gone = await api().get('/api/bookmarks').set(bearer(aarav)).expect(200);
    expect(gone.body).toHaveLength(0);
  });
});

describe('edit history', () => {
  it('keeps earlier versions, oldest first', async () => {
    const m = await send(aaravSocket, generalId, 'Standup at 10');
    await emitOk(aaravSocket, 'message:edit', { messageId: m.id, text: 'Standup at 10:30' });
    const last = await emitOk<MessageDto>(aaravSocket, 'message:edit', { messageId: m.id, text: 'Standup at 11' });
    expect(last.editCount).toBe(2);
    const history = await api().get(`/api/messages/${m.id}/history`).set(bearer(sita)).expect(200);
    expect(history.body.map((h: { text: string }) => h.text)).toEqual(['Standup at 10', 'Standup at 10:30', 'Standup at 11']);
    expect(history.body.at(-1).current).toBe(true);
  });
});

describe('threads', () => {
  it('keeps replies out of the main timeline and counts them on the first message', async () => {
    const root = await send(aaravSocket, generalId, 'Which icon set should we use?');
    const rootUpdated = waitFor<MessageDto>(aaravSocket, 'message:updated', (u) => u.id === root.id && u.thread?.replyCount === 1);
    const reply = await send(sitaSocket, generalId, 'Lucide, it matches the rest', { threadRootId: root.id });
    expect(reply.threadRootId).toBe(root.id);
    const updated = await rootUpdated;
    expect(updated.thread?.participantIds).toEqual([sita.id]);

    const page = await api().get(`/api/channels/${generalId}/messages`).set(bearer(aarav)).expect(200);
    expect(page.body.messages.map((x: MessageDto) => x.id)).not.toContain(reply.id);
    const thread = await api().get(`/api/messages/${root.id}/thread`).set(bearer(aarav)).expect(200);
    expect((thread.body as ThreadDto).replies.map((x) => x.id)).toEqual([reply.id]);
  });

  it('does not count thread replies as unread unless they mention you', async () => {
    const root = await send(aaravSocket, generalId, 'Thread about lunch');
    const read = await send(sitaSocket, generalId, 'catching up');
    await emitOk(aaravSocket, 'channel:read', { channelId: generalId, messageId: read.id });
    await send(sitaSocket, generalId, 'Momo?', { threadRootId: root.id });
    expect((await channelOf(aarav, generalId)).unread).toBe(0);
    await send(sitaSocket, generalId, `<@${aarav.id}> you in?`, { threadRootId: root.id });
    const after = await channelOf(aarav, generalId);
    expect(after.unread).toBe(1);
    expect(after.mentions).toBe(1);
  });

  it('refuses a reply in a thread from another conversation', async () => {
    const res = await api()
      .post('/api/channels')
      .set(bearer(aarav))
      .send({ name: `other-${Date.now()}`, kind: 'public' })
      .expect(201);
    const elsewhere = await send(aaravSocket, res.body.id, 'over here');
    const ack = await emit(aaravSocket, 'message:send', {
      channelId: generalId,
      clientId: clientId(),
      text: 'wrong place',
      threadRootId: elsewhere.id,
    });
    expect(ack.ok).toBe(false);
  });
});

describe('roles, removing people and archiving', () => {
  let channelId: string;
  beforeAll(async () => {
    const res = await api()
      .post('/api/channels')
      .set(bearer(aarav))
      .send({ name: `ops-${Date.now()}`, kind: 'private', memberIds: [sita.id, bikash.id] })
      .expect(201);
    channelId = res.body.id;
  });

  it('only the owner makes admins, and admins can delete anyone’s message', async () => {
    await api().post(`/api/channels/${channelId}/members/${bikash.id}/role`).set(bearer(sita)).send({ role: 'admin' }).expect(403);
    await api().post(`/api/channels/${channelId}/members/${sita.id}/role`).set(bearer(aarav)).send({ role: 'admin' }).expect(204);
    expect((await channelOf(sita, channelId)).role).toBe('admin');
    const bikashSocket = await connectSocket(app, bikash.token);
    const m = await send(bikashSocket, channelId, 'oops, wrong channel');
    const deleted = await emitOk<MessageDto>(sitaSocket, 'message:delete', { messageId: m.id });
    expect(deleted.deletedAt).not.toBeNull();
  });

  it('removes a member, who then loses access', async () => {
    const bikashSocket = await connectSocket(app, bikash.token);
    const removed = waitFor<{ channelId: string }>(bikashSocket, 'channel:removed');
    await api().delete(`/api/channels/${channelId}/members/${bikash.id}`).set(bearer(sita)).expect(204);
    expect((await removed).channelId).toBe(channelId);
    await api().get(`/api/channels/${channelId}`).set(bearer(bikash)).expect(404);
  });

  it('an admin can’t remove the owner', async () => {
    await api().delete(`/api/channels/${channelId}/members/${aarav.id}`).set(bearer(sita)).expect(403);
  });

  it('archiving stops new messages until it is undone', async () => {
    await api().post(`/api/channels/${channelId}/archive`).set(bearer(sita)).send({ archived: true }).expect(200);
    const ack = await emit(aaravSocket, 'message:send', { channelId, clientId: clientId(), text: 'hello?' });
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.status).toBe(403);
    await api().post(`/api/channels/${channelId}/archive`).set(bearer(aarav)).send({ archived: false }).expect(200);
    await send(aaravSocket, channelId, 'back in business');
  });
});

describe('notification settings', () => {
  it('is per person and per conversation', async () => {
    const res = await api().put(`/api/channels/${generalId}/notify`).set(bearer(aarav)).send({ level: 'mute' }).expect(200);
    expect(res.body.notify).toBe('mute');
    expect((await channelOf(sita, generalId)).notify).toBe('mentions');
    await api().put(`/api/channels/${generalId}/notify`).set(bearer(aarav)).send({ level: 'loud' }).expect(400);
  });
});

describe('status and do not disturb', () => {
  it('shows a status until it expires', async () => {
    const soon = new Date(Date.now() + 1500).toISOString();
    const res = await api()
      .patch('/api/users/me')
      .set(bearer(sita))
      .send({ customStatus: { emoji: '🌴', text: 'On leave', expiresAt: soon }, dndUntil: soon })
      .expect(200);
    expect(res.body.customStatus).toMatchObject({ emoji: '🌴', text: 'On leave' });
    expect(res.body.dndUntil).not.toBeNull();
    await sleep(1600);
    const later = await api().get(`/api/users/${sita.id}`).set(bearer(aarav)).expect(200);
    expect(later.body.customStatus).toBeNull();
    expect(later.body.dndUntil).toBeNull();
  });
});

describe('scheduled messages and reminders', () => {
  it('sends a scheduled message once when it is due', async () => {
    const sendAt = new Date(Date.now() + 120_000);
    const res = await api()
      .post('/api/scheduled')
      .set(bearer(aarav))
      .send({ channelId: generalId, text: 'Good morning team ☀️', sendAt })
      .expect(201);
    const list = await api().get('/api/scheduled').set(bearer(aarav)).expect(200);
    expect(list.body.map((s: { id: string }) => s.id)).toContain(res.body.id);
    expect(await app.guff.services.scheduler.tick(new Date())).toBe(0);
    const arrived = waitFor<MessageDto>(sitaSocket, 'message:new', (m) => m.text === 'Good morning team ☀️');
    expect(await app.guff.services.scheduler.tick(new Date(sendAt.getTime() + 1000))).toBe(1);
    expect((await arrived).authorId).toBe(aarav.id);
    expect(await app.guff.services.scheduler.tick(new Date(sendAt.getTime() + 2000))).toBe(0);
    expect((await Scheduled.findById(res.body.id).lean())?.status).toBe('sent');
  });

  it('refuses times in the past and lets you cancel', async () => {
    await api()
      .post('/api/scheduled')
      .set(bearer(aarav))
      .send({ channelId: generalId, text: 'too late', sendAt: new Date(Date.now() - 1000) })
      .expect(400);
    const res = await api()
      .post('/api/scheduled')
      .set(bearer(aarav))
      .send({ channelId: generalId, text: 'never mind', sendAt: new Date(Date.now() + 3_600_000) })
      .expect(201);
    await api().delete(`/api/scheduled/${res.body.id}`).set(bearer(aarav)).expect(204);
    await api().delete(`/api/scheduled/${res.body.id}`).set(bearer(aarav)).expect(404);
  });

  it('delivers a reminder to your notes, counted as unread', async () => {
    const m = await send(sitaSocket, generalId, 'Please review the contract by Friday');
    const remindAt = new Date(Date.now() + 120_000);
    await api().post('/api/reminders').set(bearer(aarav)).send({ messageId: m.id, remindAt }).expect(201);
    const reminder = waitFor<MessageDto>(aaravSocket, 'message:new', (x) => x.reminder);
    await app.guff.services.scheduler.tick(new Date(remindAt.getTime() + 1000));
    const got = await reminder;
    expect(got.ref).toMatchObject({ messageId: m.id, channelId: generalId });
    const notes = await Channel.findById(got.channelId).lean();
    expect(notes?.kind).toBe('dm');
    expect((await channelOf(aarav, got.channelId)).unread).toBe(1);
  });
});

describe('incoming webhooks', () => {
  it('posts with the secret URL and refuses a wrong secret', async () => {
    await api().post(`/api/channels/${generalId}/webhooks`).set(bearer(sita)).send({ name: 'CI' }).expect(403);
    await Membership.updateOne({ channelId: generalId, userId: aarav.id }, { $set: { role: 'admin' } });
    const created = await api().post(`/api/channels/${generalId}/webhooks`).set(bearer(aarav)).send({ name: 'CI' }).expect(201);
    const path = new URL(created.body.url).pathname;
    const arrived = waitFor<MessageDto>(sitaSocket, 'message:new', (m) => m.webhook?.name === 'CI');
    await request(app.guff.app).post(path).send({ text: 'Build #42 passed ✅' }).expect(201);
    expect((await arrived).text).toBe('Build #42 passed ✅');
    // The creator sees integration posts as unread too.
    expect((await channelOf(aarav, generalId)).unread).toBeGreaterThan(0);
    await request(app.guff.app).post(`${path.slice(0, -4)}AAAA`).send({ text: 'sneaky' }).expect(404);
    await api().delete(`/api/webhooks/${created.body.webhook.id}`).set(bearer(aarav)).expect(204);
    await request(app.guff.app).post(path).send({ text: 'after delete' }).expect(404);
  });
});

describe('password reset and email confirmation', () => {
  const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)?.[1] ?? '';

  it('resets a password with the emailed link, once, and ends old sessions', async () => {
    const email = `reset.${Date.now()}@test.local`;
    const reg = await app.guff.services.auth.register({ name: 'Reset Me', email, password: 'password123' });
    await api().post('/api/auth/forgot').send({ email }).expect(204);
    await api().post('/api/auth/forgot').send({ email: 'nobody@test.local' }).expect(204);
    const resets = mailer.sent.filter((m) => /reset/i.test(m.subject));
    expect(resets.map((m) => m.to)).toEqual([email]);
    const token = tokenFrom(resets[0]!.text);
    await api().post('/api/auth/reset').send({ token, password: 'new-password-1' }).expect(204);
    await api().post('/api/auth/reset').send({ token, password: 'another-pass-2' }).expect(400);
    await api().post('/api/auth/login').send({ email, password: 'new-password-1' }).expect(200);
    await api().post('/api/auth/login').send({ email, password: 'password123' }).expect(401);
    await api()
      .post('/api/auth/refresh')
      .set('X-Guff-Client', 'web')
      .set('Cookie', `guff_refresh=${reg.refreshToken}`)
      .expect(401);
  });

  it('confirms an email address', async () => {
    const email = `verify.${Date.now()}@test.local`;
    mailer.sent.length = 0;
    const reg = await app.guff.services.auth.register({ name: 'Verify Me', email, password: 'password123' });
    await sleep(100);
    const mail = mailer.sent.find((m) => m.to === email);
    expect(mail?.subject).toMatch(/confirm/i);
    await api().post('/api/auth/verify-email').send({ token: tokenFrom(mail!.text) }).expect(204);
    const me = await api().get('/api/auth/me').set({ authorization: `Bearer ${reg.session.accessToken}` }).expect(200);
    expect(me.body.emailVerified).toBe(true);
  });
});

describe('link previews', () => {
  it('adds a preview to the message after it is sent', async () => {
    const previewApp = await startApp(
      {},
      {
        previews: async () => ({ title: 'Guff docs', description: 'How it works', image: null, siteName: 'example.com' }),
      },
    );
    const socket = await connectSocket(previewApp, aarav.token);
    const updated = waitFor<MessageDto>(socket, 'message:updated', (m) => !!m.linkPreview);
    await send(socket, generalId, 'Read https://example.com/docs first');
    expect((await updated).linkPreview).toMatchObject({ url: 'https://example.com/docs', title: 'Guff docs' });
    socket.disconnect();
    await previewApp.close();
  });
});

describe('calls', () => {
  it('relays an invite, the answer and signals between the two people in a DM', async () => {
    const dm = await api().post('/api/dms').set(bearer(aarav)).send({ userId: sita.id }).expect(200);
    const channelId = dm.body.id as string;
    const callId = `call-${Date.now()}`;
    const incoming = waitFor<CallInvite>(sitaSocket, 'call:incoming');
    await emitOk(aaravSocket, 'call:invite', { callId, channelId, video: true });
    const invite = await incoming;
    expect(invite.fromUserId).toBe(aarav.id);

    const accepted = waitFor<{ bySocketId: string }>(aaravSocket, 'call:accepted');
    await emitOk(sitaSocket, 'call:accept', { callId, channelId, toSocketId: invite.fromSocketId });
    const answer = await accepted;
    expect(answer.bySocketId).toBe(sitaSocket.id);

    const signal = waitFor<{ data: unknown }>(sitaSocket, 'call:signal');
    await emitOk(aaravSocket, 'call:signal', { callId, channelId, toSocketId: answer.bySocketId, data: { sdp: 'offer' } });
    expect((await signal).data).toEqual({ sdp: 'offer' });

    // Signals can't be aimed at someone outside the DM.
    const bikashSocket = await connectSocket(app, bikash.token);
    const wrong = await emit(aaravSocket, 'call:signal', { callId, channelId, toSocketId: bikashSocket.id, data: {} });
    expect(wrong.ok).toBe(false);

    const ended = waitFor(sitaSocket, 'call:ended');
    const logged = waitFor<MessageDto>(sitaSocket, 'message:new', (m) => m.kind === 'system' && m.channelId === channelId);
    await emitOk(aaravSocket, 'call:end', { callId, channelId, log: 'ended', durationSec: 125, video: true });
    await ended;
    expect((await logged).text).toMatch(/video call/);
  });

  it('only works in DMs', async () => {
    const ack = await emit(aaravSocket, 'call:invite', { callId: `call-${Date.now()}`, channelId: generalId, video: false });
    expect(ack.ok).toBe(false);
  });
});

describe('voice messages', () => {
  // The start of a WebM file: an EBML header whose DocType is "webm".
  const webm = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84]),
    Buffer.from('webm'),
    Buffer.from([0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02]),
    Buffer.alloc(256),
  ]);

  it('stores a recording as audio with its length and waveform', async () => {
    const res = await api()
      .post('/api/uploads')
      .set(bearer(aarav))
      .field('voice', '1')
      .field('durationMs', '4200')
      .field('waveform', JSON.stringify([10, 50, 90, 30]))
      .attach('file', webm, 'voice.webm')
      .expect(201);
    expect(res.body).toMatchObject({ contentType: 'audio/webm', durationMs: 4200, waveform: [10, 50, 90, 30] });
    const file = await request(app.guff.app).get(res.body.url).set('Range', 'bytes=0-9').expect(206);
    expect(file.headers['content-range']).toBe(`bytes 0-9/${webm.length}`);
  });
});

describe('summaries', () => {
  it('say so when no AI key is set', async () => {
    await api().post(`/api/channels/${generalId}/summary`).set(bearer(aarav)).expect(503);
    const config = await api().get('/api/config').set(bearer(aarav)).expect(200);
    expect(config.body.ai).toBe(false);
    expect(typeof config.body.pushKey).toBe('string');
  });
});

// Keep the linter happy about the imported model used only for clean-up checks.
void Message;
