import mongoose from 'mongoose';
import type { MessageDto } from '../src/services/dto.js';
import {
  type TestApp,
  clearDatabase,
  closeSockets,
  connectSocket,
  createGeneral,
  emitOk,
  makeUser,
  startApp,
  waitFor,
} from './helpers.js';

/**
 * Two API processes behind a load balancer: with SOCKET_ADAPTER=mongo, a message sent to
 * one reaches people connected to the other. Needs a replica set (Atlas, or a local one).
 */
const hello = async () => {
  const { testEnv } = await import('./helpers.js');
  const { connectDatabase } = await import('../src/app.js');
  await connectDatabase(testEnv());
  return mongoose.connection.db!.admin().command({ hello: 1 });
};
const replicaSet = Boolean((await hello()).setName);

describe.skipIf(!replicaSet)('two API servers sharing events through MongoDB', () => {
  let one: TestApp;
  let two: TestApp;

  beforeAll(async () => {
    one = await startApp({ SOCKET_ADAPTER: 'mongo' });
    two = await startApp({ SOCKET_ADAPTER: 'mongo' });
    await clearDatabase();
  });
  afterEach(() => closeSockets());
  afterAll(async () => {
    await one.close();
    await two.close();
  });

  it('delivers a message sent through one server to a person on the other', async () => {
    const general = await createGeneral();
    const aarav = await makeUser(one, 'Aarav');
    const sita = await makeUser(one, 'Sita');
    const onServerOne = await connectSocket(one, aarav.token);
    const onServerTwo = await connectSocket(two, sita.token);

    const arrived = waitFor<MessageDto>(
      onServerTwo,
      'message:new',
      (m) => m.text === 'Across servers',
      5000,
    );
    await emitOk(onServerOne, 'message:send', {
      channelId: general._id.toString(),
      text: 'Across servers',
    });
    expect((await arrived).authorId).toBe(aarav.id);
  });

  it('sees who is online on either server', async () => {
    const sita = await makeUser(one, 'Sita Two');
    await connectSocket(two, sita.token);
    const people = await one.guff.services.people.list();
    expect(people.find((p) => p.id === sita.id)?.status).toBe('online');
  });
});
