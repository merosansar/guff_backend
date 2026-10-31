import request from 'supertest';
import { User } from '../src/models/index.js';
import type { MessageDto } from '../src/services/dto.js';
import {
  type TestApp,
  bearer,
  clearDatabase,
  closeSockets,
  connectSocket,
  createGeneral,
  emitOk,
  expectSilence,
  makeUser,
  startApp,
  waitFor,
} from './helpers.js';

let app: TestApp;

beforeAll(async () => {
  app = await startApp({ DEMO_REPLIES: 'true' });
  await clearDatabase();
  await createGeneral();
});
afterEach(() => closeSockets());
afterAll(() => app.close());

async function botAndHuman() {
  const human = await makeUser(app, 'Visitor');
  const bot = await makeUser(app, 'Nima Bot');
  await User.updateOne({ _id: bot.id }, { $set: { demoBot: true } });
  const dm = await request(app.guff.app)
    .post('/api/dms')
    .set(bearer(human))
    .send({ userId: bot.id })
    .expect(200);
  return { human, bot, dmId: dm.body.id as string };
}

describe('demo teammates', () => {
  it('show typing, then answer a DM with a labelled automated reply', async () => {
    const { human, bot, dmId } = await botAndHuman();
    const socket = await connectSocket(app, human.token);
    const typing = waitFor<{ userId: string; typing: boolean }>(
      socket,
      'typing',
      (e) => e.userId === bot.id && e.typing,
      4000,
    );
    const reply = waitFor<MessageDto>(socket, 'message:new', (m) => m.authorId === bot.id, 8000);

    await emitOk(socket, 'message:send', {
      channelId: dmId,
      text: 'Namaste! Is the Android build ready?',
    });
    await typing;
    const answer = await reply;
    expect(answer.automated).toBe(true);
    expect(answer.text.length).toBeGreaterThan(0);
  });

  it('stay quiet while someone is signed in as that teammate', async () => {
    const { human, bot, dmId } = await botAndHuman();
    const socket = await connectSocket(app, human.token);
    await connectSocket(app, bot.token);
    const silence = expectSilence(
      socket,
      'message:new',
      (m) => (m as MessageDto).authorId === bot.id,
      5000,
    );
    await emitOk(socket, 'message:send', { channelId: dmId, text: 'Hello?' });
    await silence;
  });

  it('show as online in the people list', async () => {
    const { bot } = await botAndHuman();
    const people = await app.guff.services.people.list();
    expect(people.find((p) => p.id === bot.id)).toMatchObject({ status: 'online', demo: true });
  });
});
