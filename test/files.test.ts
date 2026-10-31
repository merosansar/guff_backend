import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { BACKEND_DIR } from '../src/config/env.js';
import type { AttachmentDto, MessageDto } from '../src/services/dto.js';
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
  startApp,
} from './helpers.js';

let app: TestApp;
let aarav: TestUser;
let sita: TestUser;
let generalId: string;
let png: Buffer;
const api = () => request(app.guff.app);

const upload = (user: TestUser, buffer: Buffer, name: string) =>
  api().post('/api/uploads').set(bearer(user)).attach('file', buffer, name);

beforeAll(async () => {
  app = await startApp({ MAX_UPLOAD_MB: '1' });
  await clearDatabase();
  generalId = (await createGeneral())._id.toString();
  aarav = await makeUser(app, 'Aarav');
  sita = await makeUser(app, 'Sita');
  png = await readFile(join(BACKEND_DIR, 'seed-assets', 'yatra-colours.png'));
});
afterEach(() => closeSockets());
afterAll(() => app.close());

describe('uploads', () => {
  it('stores an image in GridFS and reads its size from the bytes', async () => {
    const res = await upload(aarav, png, 'colours.png').expect(201);
    expect(res.body).toMatchObject({
      name: 'colours.png',
      contentType: 'image/png',
      width: 900,
      height: 420,
    });
    expect(res.body.url).toMatch(/^\/api\/files\/[a-f\d]{24}\?exp=\d+&sig=/);
  });

  it('decides the type from the content, not the file name', async () => {
    const fakeImage = Buffer.from('MZ\x90\x00 this is really a Windows program');
    const res = await upload(aarav, fakeImage, 'holiday.png').expect(415);
    expect(res.body.message).toMatch(/can’t be shared here/);
  });

  it('accepts plain text files and keeps Nepali file names', async () => {
    const res = await upload(aarav, Buffer.from('नमस्ते, release notes'), 'टिप्पणी.txt').expect(
      201,
    );
    expect(res.body).toMatchObject({
      name: 'टिप्पणी.txt',
      contentType: 'text/plain; charset=utf-8',
    });
  });

  it('refuses files over the size limit', async () => {
    const res = await upload(aarav, Buffer.alloc(1.5 * 1024 * 1024, 1), 'big.txt').expect(413);
    expect(res.body.message).toBe('That file is too large.');
  });
});

describe('attachments in messages', () => {
  it('attaches an upload once, and serves it through a signed link', async () => {
    const file = (await upload(aarav, png, 'colours.png').expect(201)).body as AttachmentDto;
    const socket = await connectSocket(app, aarav.token);
    const message = await emitOk<MessageDto>(socket, 'message:send', {
      channelId: generalId,
      clientId: clientId(),
      text: '',
      attachmentIds: [file.id],
    });
    expect(message.attachments).toHaveLength(1);

    const served = await api().get(message.attachments[0]!.url).expect(200);
    expect(served.get('content-type')).toBe('image/png');
    expect(served.get('content-disposition')).toMatch(/^inline/);
    expect(served.get('content-security-policy')).toBe("default-src 'none'");
    expect(Buffer.compare(served.body as Buffer, png)).toBe(0);

    // The same upload can't be attached twice.
    const again = await emit(socket, 'message:send', {
      channelId: generalId,
      text: 'again',
      attachmentIds: [file.id],
    });
    expect(again.ok).toBe(false);
  });

  it('won’t attach someone else’s upload', async () => {
    const file = (await upload(aarav, png, 'colours.png').expect(201)).body as AttachmentDto;
    const socket = await connectSocket(app, sita.token);
    const ack = await emit(socket, 'message:send', {
      channelId: generalId,
      text: 'mine now',
      attachmentIds: [file.id],
    });
    expect(ack).toEqual({
      ok: false,
      error: {
        status: 400,
        message: 'One of the attachments isn’t available any more. Attach it again.',
      },
    });
  });

  it('rejects tampered or expired links', async () => {
    const file = (await upload(aarav, png, 'colours.png').expect(201)).body as AttachmentDto;
    const tampered = file.url.replace(/sig=.{4}/, 'sig=AAAA');
    await api().get(tampered).expect(403);
    const expired = file.url.replace(/exp=\d+/, `exp=${Date.now() - 1000}`);
    await api().get(expired).expect(403);
  });

  it('deletes the file when its message is deleted', async () => {
    const file = (await upload(aarav, png, 'colours.png').expect(201)).body as AttachmentDto;
    const socket = await connectSocket(app, aarav.token);
    const message = await emitOk<MessageDto>(socket, 'message:send', {
      channelId: generalId,
      text: 'x',
      attachmentIds: [file.id],
    });
    await emitOk(socket, 'message:delete', { messageId: message.id });
    await api().get(message.attachments[0]!.url).expect(404);
  });

  it('cleans up uploads that were never sent', async () => {
    await upload(aarav, png, 'forgotten.png').expect(201);
    expect(await app.guff.services.files.removeOrphans(0)).toBeGreaterThan(0);
  });
});
