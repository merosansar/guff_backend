import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { Channel, Membership, Message } from '../src/models/index.js';
import type { ChannelDto, MessageDto, MessagePage, ReadEvent } from '../src/services/dto.js';
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
  expectSilence,
  makeUser,
  startApp,
  waitFor,
} from './helpers.js';

let app: TestApp;
let aarav: TestUser;
let sita: TestUser;
let outsider: TestUser;
let generalId: string;
let aaravSocket: Socket;
let sitaSocket: Socket;
const api = () => request(app.guff.app);

const send = (socket: Socket, text: string, extra: Record<string, unknown> = {}) =>
  emitOk<MessageDto>(socket, 'message:send', {
    channelId: generalId,
    clientId: clientId(),
    text,
    ...extra,
  });

beforeAll(async () => {
  app = await startApp();
  await clearDatabase();
  generalId = (await createGeneral())._id.toString();
  aarav = await makeUser(app, 'Aarav');
  sita = await makeUser(app, 'Sita');
  outsider = await makeUser(app, 'Outsider');
  // The outsider leaves nothing; they're simply never in the private channel below.
});
beforeEach(async () => {
  aaravSocket = await connectSocket(app, aarav.token);
  sitaSocket = await connectSocket(app, sita.token);
});
afterEach(() => closeSockets());
afterAll(() => app.close());

describe('sending', () => {
  it('acknowledges the sender and delivers to everyone in the channel', async () => {
    const arrived = waitFor<MessageDto>(
      sitaSocket,
      'message:new',
      (m) => m.text === 'Namaste team',
    );
    const sent = await send(aaravSocket, 'Namaste team');
    expect(sent).toMatchObject({
      authorId: aarav.id,
      channelId: generalId,
      kind: 'user',
      text: 'Namaste team',
    });
    expect((await arrived).id).toBe(sent.id);
  });

  it('cleans up whitespace and refuses empty or oversized messages', async () => {
    const sent = await send(aaravSocket, '  line one  \r\n\r\nline two   \n\n');
    expect(sent.text).toBe('line one\n\nline two');
    const empty = await emit(aaravSocket, 'message:send', { channelId: generalId, text: '   \n ' });
    expect(empty).toEqual({
      ok: false,
      error: { status: 400, message: 'Write a message or attach a file.' },
    });
    const huge = await emit(aaravSocket, 'message:send', {
      channelId: generalId,
      text: 'x'.repeat(4001),
    });
    expect(huge).toEqual({
      ok: false,
      error: { status: 400, message: 'Messages can be up to 4,000 characters.' },
    });
  });

  it('makes resends harmless: the same clientId returns the same message', async () => {
    const id = clientId();
    const first = await emitOk<MessageDto>(aaravSocket, 'message:send', {
      channelId: generalId,
      clientId: id,
      text: 'Only once',
    });
    const again = await emitOk<MessageDto>(aaravSocket, 'message:send', {
      channelId: generalId,
      clientId: id,
      text: 'Only once',
    });
    expect(again.id).toBe(first.id);
    expect(await Message.countDocuments({ clientId: id })).toBe(1);
  });

  it('survives the same resend arriving twice at the same moment', async () => {
    const id = clientId();
    const [a, b] = await Promise.all([
      emitOk<MessageDto>(aaravSocket, 'message:send', {
        channelId: generalId,
        clientId: id,
        text: 'Race',
      }),
      emitOk<MessageDto>(aaravSocket, 'message:send', {
        channelId: generalId,
        clientId: id,
        text: 'Race',
      }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await Message.countDocuments({ clientId: id })).toBe(1);
  });

  it('keeps people out of conversations they are not in', async () => {
    const privateChannel = await api()
      .post('/api/channels')
      .set(bearer(aarav))
      .send({ name: 'secret-plans', kind: 'private', memberIds: [sita.id] })
      .expect(201);
    const outsiderSocket = await connectSocket(app, outsider.token);
    const attempt = await emit(outsiderSocket, 'message:send', {
      channelId: privateChannel.body.id,
      text: 'let me in',
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.status).toBe(404);

    // Nothing posted there reaches the outsider's socket either.
    const silence = expectSilence(outsiderSocket, 'message:new');
    await emitOk(aaravSocket, 'message:send', {
      channelId: privateChannel.body.id,
      text: 'Top secret',
    });
    await silence;
  });

  it('turns <@id> mentions into a list of real people only', async () => {
    const sent = await send(aaravSocket, `Hey <@${sita.id}> and <@${'a'.repeat(24)}>`);
    expect(sent.mentions).toEqual([sita.id]);
  });

  it('replies quote the original, and only within the same conversation', async () => {
    const original = await send(sitaSocket, 'Can someone check the **build**?');
    const reply = await send(aaravSocket, 'On it', { replyToId: original.id });
    expect(reply.replyTo).toEqual({
      messageId: original.id,
      authorId: sita.id,
      excerpt: 'Can someone check the build?',
    });

    const dm = await api()
      .post('/api/dms')
      .set(bearer(aarav))
      .send({ userId: sita.id })
      .expect(200);
    const cross = await emit(aaravSocket, 'message:send', {
      channelId: dm.body.id,
      text: 'x',
      replyToId: original.id,
    });
    expect(cross).toEqual({
      ok: false,
      error: { status: 400, message: 'You can only reply to a message in the same conversation.' },
    });
  });

  it('slows down a flood of messages', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        emit(aaravSocket, 'message:send', { channelId: generalId, text: `spam ${i}` }),
      ),
    );
    const limited = results.filter((r) => !r.ok && r.error.status === 429);
    expect(limited.length).toBeGreaterThan(0);
  });
});

describe('editing, deleting and reactions', () => {
  it('edits your own message and broadcasts the change', async () => {
    const sent = await send(aaravSocket, 'Teh build is green');
    const updated = waitFor<MessageDto>(sitaSocket, 'message:updated', (m) => m.id === sent.id);
    const edited = await emitOk<MessageDto>(aaravSocket, 'message:edit', {
      messageId: sent.id,
      text: 'The build is green',
    });
    expect(edited.editedAt).not.toBeNull();
    expect((await updated).text).toBe('The build is green');
  });

  it('won’t let you edit or delete someone else’s message', async () => {
    const sent = await send(aaravSocket, 'Mine');
    const edit = await emit(sitaSocket, 'message:edit', { messageId: sent.id, text: 'Hijacked' });
    expect(edit).toEqual({
      ok: false,
      error: { status: 403, message: 'You can only edit your own messages.' },
    });
    const del = await emit(sitaSocket, 'message:delete', { messageId: sent.id });
    expect(del).toEqual({
      ok: false,
      error: { status: 403, message: 'You can only delete your own messages.' },
    });
  });

  it('deletes softly: the message keeps its place but loses its content', async () => {
    const sent = await send(aaravSocket, 'Oops, wrong channel');
    await emitOk(sitaSocket, 'reaction:toggle', { messageId: sent.id, emoji: '😂' });
    const updated = waitFor<MessageDto>(
      sitaSocket,
      'message:updated',
      (m) => m.id === sent.id && m.deletedAt !== null,
    );
    await emitOk(aaravSocket, 'message:delete', { messageId: sent.id });
    const gone = await updated;
    expect(gone).toMatchObject({ text: '', reactions: [], attachments: [] });
    const again = await emit(aaravSocket, 'message:edit', { messageId: sent.id, text: 'back' });
    expect(again.ok).toBe(false);
  });

  it('toggles reactions on and off, and two people can react at once', async () => {
    const sent = await send(sitaSocket, 'We shipped!');
    const [a, b] = await Promise.all([
      emitOk<MessageDto>(aaravSocket, 'reaction:toggle', { messageId: sent.id, emoji: '🎉' }),
      emitOk<MessageDto>(sitaSocket, 'reaction:toggle', { messageId: sent.id, emoji: '🎉' }),
    ]);
    expect(a && b).toBeTruthy();
    const both = await Message.findById(sent.id).lean();
    expect(both!.reactions).toHaveLength(1);
    expect(both!.reactions[0]!.userIds.map(String).sort()).toEqual([aarav.id, sita.id].sort());

    await emitOk(aaravSocket, 'reaction:toggle', { messageId: sent.id, emoji: '🎉' });
    const off = await emitOk<MessageDto>(sitaSocket, 'reaction:toggle', {
      messageId: sent.id,
      emoji: '🎉',
    });
    expect(off.reactions).toEqual([]);

    const bad = await emit(aaravSocket, 'reaction:toggle', { messageId: sent.id, emoji: '💩' });
    expect(bad).toEqual({
      ok: false,
      error: { status: 400, message: 'That reaction isn’t available.' },
    });
  });
});

describe('history', () => {
  let channelId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    const channel = await app.guff.services.channels.create(aarav.id, {
      name: 'history-test',
      kind: 'public',
    });
    channelId = channel.id;
    for (let i = 0; i < 30; i++) {
      const { message } = await app.guff.services.messages.send(aarav.id, {
        channelId,
        text: `message ${i}`,
      });
      ids.push(message.id);
    }
  });

  const page = async (query: string) =>
    (await api().get(`/api/channels/${channelId}/messages?${query}`).set(bearer(aarav)).expect(200))
      .body as MessagePage;

  it('returns the newest page first, oldest to newest', async () => {
    const latest = await page('limit=10');
    expect(latest.messages.map((m) => m.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `message ${20 + i}`),
    );
    expect(latest.hasMoreBefore).toBe(true);
    expect(latest.hasMoreAfter).toBe(false);
  });

  it('pages backwards with before and forwards with after (catching up after a reconnect)', async () => {
    const older = await page(`before=${ids[20]}&limit=10`);
    expect(older.messages[0]!.text).toBe('message 10');
    expect(older.messages.at(-1)!.text).toBe('message 19');
    const missed = await page(`after=${ids[25]}`);
    expect(missed.messages.map((m) => m.text)).toEqual([
      'message 26',
      'message 27',
      'message 28',
      'message 29',
    ]);
    expect(missed.hasMoreAfter).toBe(false);
  });

  it('opens around a message, for jumping to a search result', async () => {
    const around = await page(`around=${ids[5]}&limit=6`);
    expect(around.messages.map((m) => m.text)).toContain('message 5');
    expect(around.hasMoreBefore).toBe(true);
    expect(around.hasMoreAfter).toBe(true);
  });
});

describe('unread counts and read receipts', () => {
  it('counts unread messages and mentions per channel', async () => {
    const channel = await app.guff.services.channels.create(aarav.id, {
      name: 'unread-test',
      kind: 'public',
      memberIds: [sita.id],
    });
    await app.guff.services.messages.send(aarav.id, { channelId: channel.id, text: 'one' });
    await app.guff.services.messages.send(aarav.id, {
      channelId: channel.id,
      text: `two <@${sita.id}>`,
    });
    const list = (await api().get('/api/channels').set(bearer(sita)).expect(200))
      .body as ChannelDto[];
    expect(list.find((c) => c.id === channel.id)).toMatchObject({ unread: 2, mentions: 1 });
    // Your own messages are never unread for you.
    const mine = (await api().get('/api/channels').set(bearer(aarav)).expect(200))
      .body as ChannelDto[];
    expect(mine.find((c) => c.id === channel.id)).toMatchObject({ unread: 0 });
  });

  it('marks read across all your tabs, and only ever forwards', async () => {
    const channel = await app.guff.services.channels.create(aarav.id, {
      name: 'read-sync',
      kind: 'public',
      memberIds: [sita.id],
    });
    const first = (
      await app.guff.services.messages.send(aarav.id, { channelId: channel.id, text: 'first' })
    ).message;
    const second = (
      await app.guff.services.messages.send(aarav.id, { channelId: channel.id, text: 'second' })
    ).message;
    const otherTab = await connectSocket(app, sita.token);

    const heard = waitFor<ReadEvent>(otherTab, 'read', (e) => e.channelId === channel.id);
    expect(
      await emitOk(sitaSocket, 'channel:read', { channelId: channel.id, messageId: second.id }),
    ).toBe(true);
    expect((await heard).messageId).toBe(second.id);

    expect(
      await emitOk(sitaSocket, 'channel:read', { channelId: channel.id, messageId: first.id }),
    ).toBe(false);
    const membership = await Membership.findOne({ channelId: channel.id, userId: sita.id }).lean();
    expect(membership!.lastReadId!.toString()).toBe(second.id);
  });

  it('tells the other person in a DM when you have read their message', async () => {
    const dm = await api()
      .post('/api/dms')
      .set(bearer(aarav))
      .send({ userId: sita.id })
      .expect(200);
    const sent = await emitOk<MessageDto>(aaravSocket, 'message:send', {
      channelId: dm.body.id,
      text: 'Seen?',
    });
    const receipt = waitFor<ReadEvent>(
      aaravSocket,
      'read',
      (e) => e.userId === sita.id && e.channelId === dm.body.id,
    );
    await emitOk(sitaSocket, 'channel:read', { channelId: dm.body.id, messageId: sent.id });
    expect((await receipt).messageId).toBe(sent.id);
  });
});

describe('typing', () => {
  it('relays typing to the others in the channel, not to the typist', async () => {
    const seen = waitFor<{ userId: string; typing: boolean }>(
      sitaSocket,
      'typing',
      (e) => e.userId === aarav.id,
    );
    const notEcho = expectSilence(aaravSocket, 'typing');
    aaravSocket.emit('typing', { channelId: generalId, typing: true });
    expect((await seen).typing).toBe(true);
    await notEcho;
  });

  it('ignores typing for a channel the socket is not in', async () => {
    const privateChannel = await Channel.findOne({ name: 'secret-plans' }).lean();
    const outsiderSocket = await connectSocket(app, outsider.token);
    const silence = expectSilence(
      sitaSocket,
      'typing',
      (e) => (e as { userId: string }).userId === outsider.id,
    );
    outsiderSocket.emit('typing', { channelId: privateChannel!._id.toString(), typing: true });
    await silence;
  });
});

describe('search', () => {
  it('finds words in your conversations only', async () => {
    const secret = await Channel.findOne({ name: 'secret-plans' }).lean();
    await app.guff.services.messages.send(aarav.id, {
      channelId: secret!._id.toString(),
      text: 'The rhododendron launch codename',
    });
    await app.guff.services.messages.send(aarav.id, {
      channelId: generalId,
      text: 'Rhododendron season in Ghorepani',
    });

    const mine = (await api().get('/api/search?q=rhododendron').set(bearer(sita)).expect(200))
      .body as MessageDto[];
    expect(mine.map((m) => m.text).sort()).toEqual([
      'Rhododendron season in Ghorepani',
      'The rhododendron launch codename',
    ]);
    const theirs = (await api().get('/api/search?q=rhododendron').set(bearer(outsider)).expect(200))
      .body as MessageDto[];
    expect(theirs.map((m) => m.text)).toEqual(['Rhododendron season in Ghorepani']);
  });
});
