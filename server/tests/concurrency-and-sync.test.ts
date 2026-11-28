import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, registerAndBindAgy, TestApiClient } from './helpers/test-harness.js';

describe('Concurrency, Fair Scheduler, Multi-Device WS Catchup, Permissions & Recovery', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });


  it('snapshot uses the same active-run priority across chats and excludes other users', async () => {
    const srv=await createTestServer();cleanups.push(srv.cleanup);
    const {client:alice,userId}=await registerAndBindAgy(srv.baseUrl,'alice','user:alice@gmail.com');
    const {client:bob,userId:bobId}=await registerAndBindAgy(srv.baseUrl,'bob','user:bob@gmail.com');
    const createChat=async(client:TestApiClient)=>(await client.request<{chat:{id:string}}>('POST','/api/chats',{})).data.chat.id;
    const a=await createChat(alice),b=await createChat(alice),other=await createChat(bob);
    const db=srv.ctx.db;
    const add=(chatId:string,owner:string,id:string,status:'queued'|'running'|'awaiting_permission'|'completed')=>{
      const msg=db.createMessage({id:'msg-'+id,chatId,userId:owner,role:'assistant',contentText:id,status:'streaming',runId:id});
      return db.createRun({id,chatId,userId:owner,userMessageId:msg.id,assistantMessageId:msg.id,status,queuePosition:0,modelId:null,effortValue:null});
    };
    add(a,userId,'queued','queued');add(a,userId,'working','running');
    add(b,userId,'finished','completed');add(b,userId,'permission','awaiting_permission');
    add(other,bobId,'foreign','running');
    const snap=db.getSyncSnapshot(userId,a);
    expect(snap.chats.map(c=>[c.id,c.activeRun?.id]).sort()).toEqual([[a,'working'],[b,'permission']].sort());
    expect(snap.activeChatDetail?.activeRun?.id).toBe(db.getActiveRunForChat(userId,a)?.id);
    expect(snap.chats.some(c=>c.id===other)).toBe(false);
  });

  it('runs multiple users simultaneously on isolated HOME profiles without blocking one another', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const { client: bob } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');

    await alice.connectWs({ clientId: 'alice-dev1' });
    await bob.connectWs({ clientId: 'bob-dev1' });

    const chatA = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {})).data.chat.id;
    const chatB = (await bob.request<{ chat: { id: string } }>('POST', '/api/chats', {})).data.chat.id;

    const t0 = Date.now();
    await Promise.all([
      alice.request('POST', `/api/chats/${chatA}/messages`, { text: '[SLEEP_MS:650] From Alice' }),
      bob.request('POST', `/api/chats/${chatB}/messages`, { text: '[SLEEP_MS:650] From Bob' }),
    ]);

    const [doneA, doneB] = await Promise.all([
      alice.waitForFrame((f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'),
      bob.waitForFrame((f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'),
    ]);
    const elapsed = Date.now() - t0;

    // Parallel execution finishes far under serialized time (650ms * 2 = 1300ms + startup)
    expect(elapsed).toBeLessThan(1250);

    const textA = ((doneA.event as { payload: { message: { contentText: string } } }).payload.message).contentText;
    const textB = ((doneB.event as { payload: { message: { contentText: string } } }).payload.message).contentText;
    expect(textA).toContain('alice@gmail.com');
    expect(textA).toContain('From Alice');
    expect(textB).toContain('bob@gmail.com');
    expect(textB).toContain('From Bob');

    alice.closeWs();
    bob.closeWs();
  });

  it('serializes same-chat turns, deduplicates clientMessageId, supports mid-stream Device B join & reconnect sinceSeq catchup', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: aliceA } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await aliceA.connectWs({ clientId: 'alice-pc' });

    const chatId = (await aliceA.request<{ chat: { id: string } }>('POST', '/api/chats', {})).data.chat.id;

    // Start slow streaming run on Device A
    const send1 = await aliceA.request<{ run: { id: string }; deduplicated: boolean }>(
      'POST',
      `/api/chats/${chatId}/messages`,
      { text: '[SLEEP_MS:350] Streaming check alpha beta gamma', clientMessageId: 'msg-idemp-1' }
    );
    expect(send1.status).toBe(202);
    expect(send1.data.deduplicated).toBe(false);

    // Duplicate retry with same clientMessageId deduplicates cleanly
    const send1Dup = await aliceA.request<{ run: { id: string }; deduplicated: boolean }>(
      'POST',
      `/api/chats/${chatId}/messages`,
      { text: '[SLEEP_MS:350] Streaming check alpha beta gamma', clientMessageId: 'msg-idemp-1' }
    );
    expect(send1Dup.status).toBe(200);
    expect(send1Dup.data.deduplicated).toBe(true);
    expect(send1Dup.data.run.id).toBe(send1.data.run.id);

    // Enqueue a second message while first is still running -> queued & cancelable or sequential
    const send2 = await aliceA.request<{ run: { id: string; status: string } }>(
      'POST',
      `/api/chats/${chatId}/messages`,
      { text: 'Second queued turn' }
    );
    expect(send2.data.run.status).toBe('queued');

    // Device B (same user, e.g., iPhone) logs in cleanly mid-stream!
    const aliceB = new TestApiClient(srv.baseUrl);
    await aliceB.request('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
    const helloB = await aliceB.connectWs({ clientId: 'alice-iphone' });
    const seqBeforeDisconnect = Number(helloB.latestSeq);

    // Both devices observe second run finishing cleanly in order
    await aliceB.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === send2.data.run.id
    );

    // Disconnect Device B, make a title rename on Device A, then reconnect Device B with sinceSeq
    aliceB.closeWs();
    await aliceA.request('PATCH', `/api/chats/${chatId}`, { title: 'Renamed On PC' });

    const replayHello = await aliceB.connectWs({
      clientId: 'alice-iphone',
      sinceSeq: seqBeforeDisconnect,
    });
    const missedEvents = replayHello.events as Array<{ type: string; payload?: { chat?: { title?: string } } }>;
    expect(
      missedEvents.some((e) => e.type === 'chat.updated' && e.payload?.chat?.title === 'Renamed On PC')
    ).toBe(true);

    aliceA.closeWs();
    aliceB.closeWs();
  });

  it('syncs permission requests across devices, rejects double resolution with 409, and recovers ACP session after worker eviction', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: devA, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const devB = new TestApiClient(srv.baseUrl);
    await devB.request('POST', '/api/auth/login', { username: 'alice', password: 'password123' });

    await devA.connectWs({ clientId: 'devA' });
    await devB.connectWs({ clientId: 'devB' });

    const chatRes = await devA.request<{
      chat: { id: string };
      sessionOptions: { configOptions: Array<{ id: string; options: Array<{ value: string }> }> };
    }>('POST', '/api/chats', {});
    const chatId = chatRes.data.chat.id;

    // Verify dynamic model -> dependent effort configOptions behavior
    const flashPatch = await devA.request<{
      chat: { modelId: string; effortValue: string };
      sessionOptions: { configOptions: Array<{ id: string; options: Array<{ value: string }> }> };
    }>('PATCH', `/api/chats/${chatId}`, { modelId: 'gemini-2.5-flash' });
    expect(flashPatch.data.chat.modelId).toBe('gemini-2.5-flash');
    const effortOpt = flashPatch.data.sessionOptions.configOptions.find((c) => c.id === 'reasoning_effort');
    expect(effortOpt?.options.some((o) => o.value === 'high')).toBe(false);

    // Send permission-triggering prompt
    await devA.request('POST', `/api/chats/${chatId}/messages`, {
      text: 'Please create file [PERMISSION]',
    });

    // Both Device A and Device B receive the same permission.requested event
    const [permEvtA, permEvtB] = await Promise.all([
      devA.waitForFrame((f) => f.kind === 'event' && (f.event as { type: string }).type === 'permission.requested'),
      devB.waitForFrame((f) => f.kind === 'event' && (f.event as { type: string }).type === 'permission.requested'),
    ]);
    const permId = ((permEvtA.event as { payload: { permission: { id: string } } }).payload.permission).id;
    expect(((permEvtB.event as { payload: { permission: { id: string } } }).payload.permission).id).toBe(permId);

    // Device A approves first -> succeeds (200); Device B taps second -> atomic 409 ALREADY_RESOLVED
    const resA = await devA.request('POST', `/api/chats/${chatId}/permissions/${permId}`, {
      optionId: 'allow_once',
      clientId: 'devA',
    });
    expect(resA.status).toBe(200);

    const resB = await devB.request<{ error: string }>('POST', `/api/chats/${chatId}/permissions/${permId}`, {
      optionId: 'reject_once',
      clientId: 'devB',
    });
    expect(resB.status).toBe(409);
    expect(resB.data.error).toBe('ALREADY_RESOLVED');

    // Run completes and produces created-by-tool.md via ACP fs/writeTextFile
    const finEvt = await devA.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );
    const finText = ((finEvt.event as { payload: { message: { contentText: string } } }).payload.message).contentText;
    expect(finText).toContain('created-by-tool.md');

    // Simulate ACP process exit / idle eviction (AC-17) and send another turn -> recovers cleanly
    await srv.ctx.acp.stopChatWorker(userId, chatId);
    const postEvictionSend = await devA.request('POST', `/api/chats/${chatId}/messages`, {
      text: 'After ACP restart turn',
    });
    expect(postEvictionSend.status).toBe(202);
    const postFin = await devA.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string }).type === 'run.finished' &&
        ((f.event as { payload: { message: { contentText: string } } }).payload.message).contentText.includes(
          'After ACP restart turn'
        ),
      8000,
      true
    );
    expect(postFin).toBeTruthy();

    devA.closeWs();
    devB.closeWs();
  });

  it('cancels active or queued runs cleanly, recovers interrupted runs on startup, and serves built SPA bundle', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    // Health and static SPA index check
    const health = await fetch(`${srv.baseUrl}/api/health`).then((r) => r.json() as Promise<{ ok: boolean; agyMode: string }>);
    expect(health.ok).toBe(true);
    expect(health.agyMode).toBe('mock');

    const rootHtml = await fetch(`${srv.baseUrl}/`);
    expect(rootHtml.status).toBe(200);
    expect(await rootHtml.text()).toContain('<div id="root"></div>');

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs({ clientId: 'alice-cancel' });

    const chatId = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {})).data.chat.id;

    // Start slow run #1 and enqueue run #2
    const r1 = (
      await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
        text: '[SLEEP_MS:3000] Long task 1',
      })
    ).data.run.id;

    const r2 = (
      await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
        text: 'Queued task 2',
      })
    ).data.run.id;

    // Cancel queued run #2 immediately -> cancelled
    const cancel2 = await alice.request<{ run: { status: string; stopReason: string } }>(
      'POST',
      `/api/chats/${chatId}/runs/${r2}/cancel`
    );
    expect(cancel2.status).toBe(200);
    expect(cancel2.data.run.status).toBe('cancelled');

    // Cancel active run #1 -> wait for run.finished cancelled
    await alice.request('POST', `/api/chats/${chatId}/runs/${r1}/cancel`);
    const fin1 = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === r1
    );
    expect(
      ((fin1.event as { payload: { run: { status: string } } }).payload.run).status
    ).toBe('cancelled');

    // Simulate interrupted leftover DB state across sudden restart -> recoverInterruptedRuns() resets cleanly
    const mockMsg = srv.ctx.db.createMessage({
      id: 'interrupted-msg-1',
      chatId,
      userId,
      role: 'assistant',
      contentText: 'partial',
      status: 'streaming',
      runId: 'interrupted-run-1',
    });
    srv.ctx.db.createRun({
      id: 'interrupted-run-1',
      chatId,
      userId,
      userMessageId: mockMsg.id,
      assistantMessageId: mockMsg.id,
      status: 'running',
      queuePosition: 0,
      modelId: null,
      effortValue: null,
    });
    srv.ctx.db.recoverInterruptedRuns();
    const recoveredRun = srv.ctx.db.getRun(userId, 'interrupted-run-1')!;
    expect(recoveredRun.status).toBe('error');
    expect(recoveredRun.stopReason).toBe('server_restart');

    alice.closeWs();
  });
});

