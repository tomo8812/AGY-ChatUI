import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { PushNotificationService } from '../notifications/web-push.js';
import type { SyncHub } from '../sync/hub.js';
import type { AttachmentRef, ChatRecord, MessageRecord, RunRecord } from '../types.js';
import type { AcpClientManager } from './client-manager.js';
import type { QuotaService } from './quota-service.js';

interface QueuedTurnJob {
  runId: string;
  userId: string;
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
  attachments: AttachmentRef[];
  abortController: AbortController;
  enqueuedAt: number;
}

export class ExecutionScheduler {
  private readonly queue: QueuedTurnJob[] = [];
  private readonly activeJobs = new Map<string, QueuedTurnJob>(); // runId -> job
  private readonly activePromises = new Map<string, Promise<void>>(); // runId -> settled promise
  private readonly suppressedRunIds = new Set<string>();
  private readonly activeChatIds = new Set<string>();
  private readonly activeByUser = new Map<string, number>();
  private lastScheduledUserIndex = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub,
    private readonly acp: AcpClientManager,
    private readonly pushService?: PushNotificationService,
    private readonly quotaService?: QuotaService
  ) {}

  enqueueTurn(params: {
    userId: string;
    chatId: string;
    userText: string;
    attachments: AttachmentRef[];
    clientMessageId?: string | null;
  }): {
    userMessage: MessageRecord;
    assistantMessage: MessageRecord;
    run: RunRecord;
    chat: ChatRecord;
    deduplicated: boolean;
  } {
    // Idempotency across reconnects / dual device taps
    if (params.clientMessageId) {
      const existingUserMsg = this.db.findMessageByClientId(params.userId, params.chatId, params.clientMessageId);
      if (existingUserMsg && existingUserMsg.runId) {
        const existingRun = this.db.getRun(params.userId, existingUserMsg.runId);
        if (existingRun) {
          const existingAssistant = this.db.getMessage(params.userId, existingRun.assistantMessageId);
          const existingChat = this.db.getChat(params.userId, params.chatId);
          if (existingAssistant && existingChat) {
            return {
              userMessage: existingUserMsg,
              assistantMessage: existingAssistant,
              run: existingRun,
              chat: existingChat,
              deduplicated: true,
            };
          }
        }
      }
    }

    const chat = this.db.getChat(params.userId, params.chatId);
    if (!chat) throw new Error('Chat not found');

    const profile = this.db.getAgyProfile(params.userId);
    if (!profile || profile.authStatus !== 'authenticated') {
      throw new Error('Antigravity認証が完了していないため送信できません。');
    }

    const now = Date.now();
    const runId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const queuePosition = this.queue.length + 1;

    const userMessage = this.db.createMessage({
      id: userMessageId,
      chatId: params.chatId,
      userId: params.userId,
      clientMessageId: params.clientMessageId,
      role: 'user',
      contentText: params.userText,
      attachments: params.attachments,
      status: 'completed',
      runId,
      createdAt: now,
    });

    const assistantMessage = this.db.createMessage({
      id: assistantMessageId,
      chatId: params.chatId,
      userId: params.userId,
      role: 'assistant',
      contentText: '',
      status: 'queued',
      runId,
      createdAt: now + 1,
    });

    const run = this.db.createRun({
      id: runId,
      chatId: params.chatId,
      userId: params.userId,
      userMessageId,
      assistantMessageId,
      status: 'queued',
      queuePosition,
      modelId: chat.modelId,
      effortValue: chat.effortValue,
    });

    const updatedChat = this.db.updateChat(params.userId, params.chatId, {
      lastMessageAt: now,
      title:
        chat.title === '新しいチャット' && params.userText.trim()
          ? params.userText.trim().slice(0, 48)
          : undefined,
    })!;

    this.hub.emitDurable({
      userId: params.userId,
      type: 'message.created',
      chatId: params.chatId,
      runId,
      payload: {
        messages: [userMessage, assistantMessage],
        run,
        chat: updatedChat,
      },
    });

    const job: QueuedTurnJob = {
      runId,
      userId: params.userId,
      chatId: params.chatId,
      userMessageId,
      assistantMessageId,
      userText: params.userText,
      attachments: params.attachments,
      abortController: new AbortController(),
      enqueuedAt: now,
    };

    this.queue.push(job);
    this.pump();

    return {
      userMessage,
      assistantMessage: this.db.getMessage(params.userId, assistantMessageId)!,
      run: this.db.getRun(params.userId, runId)!,
      chat: updatedChat,
      deduplicated: false,
    };
  }

  enqueueTurnForExistingUserMessage(params: {
    userId: string;
    chatId: string;
    userMessageId: string;
  }): {
    userMessage: MessageRecord;
    assistantMessage: MessageRecord;
    run: RunRecord;
    chat: ChatRecord;
  } {
    const chat = this.db.getChat(params.userId, params.chatId);
    if (!chat) throw new Error('Chat not found');

    const profile = this.db.getAgyProfile(params.userId);
    if (!profile || profile.authStatus !== 'authenticated') {
      throw new Error('Antigravity認証が完了していないため送信できません。');
    }

    const existingUserMsg = this.db.getMessage(params.userId, params.userMessageId);
    if (!existingUserMsg || existingUserMsg.chatId !== params.chatId || existingUserMsg.role !== 'user') {
      throw new Error('User message not found');
    }

    const now = Math.max(Date.now(), existingUserMsg.createdAt + 1);
    const runId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const queuePosition = this.queue.length + 1;

    const userMessage = this.db.updateMessage(params.userId, existingUserMsg.id, {
      runId,
      status: 'completed',
      errorMessage: null,
    })!;

    const assistantMessage = this.db.createMessage({
      id: assistantMessageId,
      chatId: params.chatId,
      userId: params.userId,
      role: 'assistant',
      contentText: '',
      status: 'queued',
      runId,
      createdAt: now,
    });

    const run = this.db.createRun({
      id: runId,
      chatId: params.chatId,
      userId: params.userId,
      userMessageId: userMessage.id,
      assistantMessageId,
      status: 'queued',
      queuePosition,
      modelId: chat.modelId,
      effortValue: chat.effortValue,
    });

    const updatedChat = this.db.updateChat(params.userId, params.chatId, {
      lastMessageAt: now,
    })!;

    this.hub.emitDurable({
      userId: params.userId,
      type: 'message.created',
      chatId: params.chatId,
      runId,
      payload: {
        messages: [userMessage, assistantMessage],
        run,
        chat: updatedChat,
      },
    });

    const job: QueuedTurnJob = {
      runId,
      userId: params.userId,
      chatId: params.chatId,
      userMessageId: userMessage.id,
      assistantMessageId,
      userText: userMessage.contentText,
      attachments: userMessage.attachments,
      abortController: new AbortController(),
      enqueuedAt: now,
    };

    this.queue.push(job);
    this.pump();

    return {
      userMessage,
      assistantMessage: this.db.getMessage(params.userId, assistantMessageId)!,
      run: this.db.getRun(params.userId, runId)!,
      chat: updatedChat,
    };
  }

  async cancelAllForChatAndWait(userId: string, chatId: string): Promise<void> {
    // 1. Drain any queued jobs for this chat before cancelling active work
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const job = this.queue[i];
      if (job.userId === userId && job.chatId === chatId) {
        this.queue.splice(i, 1);
        job.abortController.abort();
        this.db.updateRun(userId, job.runId, {
          status: 'cancelled',
          queuePosition: 0,
          stopReason: 'rewound',
          finishedAt: Date.now(),
        });
        this.db.updateMessage(userId, job.assistantMessageId, { status: 'cancelled' });
      }
    }

    // 2. Abort any active job on this chat and wait for it to finish cleanly
    const activeForChat = [...this.activeJobs.values()].filter(
      (j) => j.userId === userId && j.chatId === chatId
    );
    for (const active of activeForChat) {
      this.suppressedRunIds.add(active.runId);
      active.abortController.abort();
      await this.acp.cancelTurn(userId, chatId, active.runId).catch(() => {});
    }

    const promises = activeForChat
      .map((j) => this.activePromises.get(j.runId))
      .filter((p): p is Promise<void> => Boolean(p));

    if (promises.length > 0) {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => setTimeout(resolve, 600)),
      ]);
    }

    // 3. Stop chat ACP worker so any remaining turn / background subagent exits cleanly
    await this.acp.stopChatWorker(userId, chatId);

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }

    for (const active of activeForChat) {
      this.suppressedRunIds.delete(active.runId);
    }
    this.notifyQueuePositions();
  }

  async cancelRun(userId: string, chatId: string, runId: string): Promise<RunRecord | null> {
    const run = this.db.getRun(userId, runId);
    if (!run || run.chatId !== chatId || run.userId !== userId) {
      return null;
    }

    // Remove cleanly if still queued
    const qIdx = this.queue.findIndex((j) => j.runId === runId && j.userId === userId);
    if (qIdx >= 0) {
      const [removed] = this.queue.splice(qIdx, 1);
      removed.abortController.abort();
      const now = Date.now();
      const nextRun = this.db.updateRun(userId, runId, {
        status: 'cancelled',
        queuePosition: 0,
        stopReason: 'cancelled',
        finishedAt: now,
      })!;
      const nextMsg = this.db.updateMessage(userId, removed.assistantMessageId, { status: 'cancelled' })!;
      const nextActiveRun = this.db.getActiveRunForChat(userId, chatId);
      this.hub.emitDurable({
        userId,
        type: 'run.finished',
        chatId,
        runId,
        payload: { run: nextRun, message: nextMsg, nextActiveRun },
      });
      this.notifyQueuePositions();
      return nextRun;
    }

    // Active run -> abort and trigger ACP cancel notification
    const active = this.activeJobs.get(runId);
    if (active && active.userId === userId) {
      active.abortController.abort();
      await this.acp.cancelTurn(userId, chatId, runId);
      return this.db.getRun(userId, runId);
    }

    return run;
  }

  getQueueSnapshotForUser(userId: string): {
    runningCount: number;
    queuedCount: number;
  } {
    const runningCount = this.activeByUser.get(userId) ?? 0;
    const queuedCount = this.queue.filter((j) => j.userId === userId).length;
    return { runningCount, queuedCount };
  }

  private pump(): void {
    while (this.activeJobs.size < this.config.maxConcurrentAcp && this.queue.length > 0) {
      const nextIndex = this.pickNextFairJobIndex();
      if (nextIndex < 0) break;
      const [job] = this.queue.splice(nextIndex, 1);
      this.startJob(job);
    }
    this.notifyQueuePositions();
  }

  /**
   * Fair round-robin user scheduling respecting:
   *  - strict serial execution per `chatId` (so same-chat concurrent prompts queue safely)
   *  - strict per-user active cap `config.maxAcpPerUser` (so heavy user A cannot starve user B)
   */
  private pickNextFairJobIndex(): number {
    const distinctUsers: string[] = [];
    for (const job of this.queue) {
      if (!distinctUsers.includes(job.userId)) distinctUsers.push(job.userId);
    }
    if (distinctUsers.length === 0) return -1;

    for (let offset = 0; offset < distinctUsers.length; offset += 1) {
      const userIndex = (this.lastScheduledUserIndex + offset) % distinctUsers.length;
      const candidateUser = distinctUsers[userIndex];
      const userRunning = this.activeByUser.get(candidateUser) ?? 0;
      if (userRunning >= this.config.maxAcpPerUser) continue;

      const jobIdx = this.queue.findIndex(
        (j) => j.userId === candidateUser && !this.activeChatIds.has(j.chatId)
      );
      if (jobIdx >= 0) {
        this.lastScheduledUserIndex = (userIndex + 1) % distinctUsers.length;
        return jobIdx;
      }
    }
    return -1;
  }

  private startJob(job: QueuedTurnJob): void {
    this.activeJobs.set(job.runId, job);
    this.activeChatIds.add(job.chatId);
    this.activeByUser.set(job.userId, (this.activeByUser.get(job.userId) ?? 0) + 1);

    const now = Date.now();
    const run = this.db.updateRun(job.userId, job.runId, {
      status: 'running',
      queuePosition: 0,
      startedAt: now,
    })!;
    const msg = this.db.updateMessage(job.userId, job.assistantMessageId, {
      status: 'streaming',
    })!;

    this.hub.emitDurable({
      userId: job.userId,
      type: 'run.started',
      chatId: job.chatId,
      runId: job.runId,
      payload: { run, message: msg },
    });

    const promise = this.runAsync(job).finally(() => {
      this.activePromises.delete(job.runId);
    });
    this.activePromises.set(job.runId, promise);
  }

  private async runAsync(job: QueuedTurnJob): Promise<void> {
    try {
      const { stopReason } = await this.acp.executeTurn({
        userId: job.userId,
        chatId: job.chatId,
        runId: job.runId,
        userText: job.userText,
        attachments: job.attachments,
        assistantMessageId: job.assistantMessageId,
        abortSignal: job.abortController.signal,
      });

      if (this.suppressedRunIds.has(job.runId)) {
        return;
      }

      const finishedAt = Date.now();
      const status = stopReason === 'cancelled' ? 'cancelled' : 'completed';
      const finalRun = this.db.updateRun(job.userId, job.runId, {
        status,
        stopReason,
        finishedAt,
      })!;
      const finalMsg = this.db.getMessage(job.userId, job.assistantMessageId)!;
      const nextActiveRun = this.db.getActiveRunForChat(job.userId, job.chatId);

      this.hub.emitDurable({
        userId: job.userId,
        type: 'run.finished',
        chatId: job.chatId,
        runId: job.runId,
        payload: { run: finalRun, message: finalMsg, nextActiveRun },
      });

      if (status !== 'cancelled') {
        void this.pushService
          ?.notifyRunFinished({
            userId: job.userId,
            chatId: job.chatId,
            runId: job.runId,
            status,
            previewText: finalMsg.contentText,
          })
          .catch((err) => {
            console.warn('[scheduler] Push notification failed:', err);
          });
        void this.quotaService?.refreshOnDemand(job.userId, { auto: true, minAgeMs: 5_000 }).catch(() => {});
      }
    } catch (err) {
      if (this.suppressedRunIds.has(job.runId)) {
        return;
      }
      const finishedAt = Date.now();
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isCancelled = job.abortController.signal.aborted;
      const finalRun = this.db.updateRun(job.userId, job.runId, {
        status: isCancelled ? 'cancelled' : 'error',
        stopReason: isCancelled ? 'cancelled' : 'error',
        errorMessage: isCancelled ? null : errorMsg,
        finishedAt,
      })!;
      const finalMsg = this.db.updateMessage(job.userId, job.assistantMessageId, {
        status: isCancelled ? 'cancelled' : 'error',
        errorMessage: isCancelled ? null : errorMsg,
      })!;
      const nextActiveRun = this.db.getActiveRunForChat(job.userId, job.chatId);

      this.hub.emitDurable({
        userId: job.userId,
        type: 'run.finished',
        chatId: job.chatId,
        runId: job.runId,
        payload: { run: finalRun, message: finalMsg, nextActiveRun },
      });

      if (!isCancelled) {
        void this.pushService
          ?.notifyRunFinished({
            userId: job.userId,
            chatId: job.chatId,
            runId: job.runId,
            status: 'error',
            errorMessage: errorMsg,
          })
          .catch((pushErr) => {
            console.warn('[scheduler] Error push notification failed:', pushErr);
          });
        void this.quotaService?.refreshOnDemand(job.userId, { auto: true, minAgeMs: 5_000 }).catch(() => {});
      }
    } finally {
      this.activeJobs.delete(job.runId);
      this.activeChatIds.delete(job.chatId);
      const nextCount = Math.max(0, (this.activeByUser.get(job.userId) ?? 1) - 1);
      if (nextCount === 0) this.activeByUser.delete(job.userId);
      else this.activeByUser.set(job.userId, nextCount);
      this.pump();
    }
  }

  private notifyQueuePositions(): void {
    const userQueues = new Map<string, QueuedTurnJob[]>();
    for (const j of this.queue) {
      const list = userQueues.get(j.userId) ?? [];
      list.push(j);
      userQueues.set(j.userId, list);
    }

    for (const [userId, list] of userQueues.entries()) {
      list.forEach((job, idx) => {
        const pos = idx + 1;
        this.db.updateRun(userId, job.runId, { queuePosition: pos });
        this.hub.emitEphemeral({
          userId,
          type: 'run.queue_position',
          chatId: job.chatId,
          runId: job.runId,
          payload: { runId: job.runId, queuePosition: pos },
        });
      });
    }
  }
}
