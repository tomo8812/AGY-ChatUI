import type { MessageRecord } from '../types';

export function newerMessage(current: MessageRecord, incoming: MessageRecord): MessageRecord {
  if (incoming.updatedAt > current.updatedAt) return incoming;
  if (current.updatedAt > incoming.updatedAt) return current;
  const currentIsTerminal = current.status !== 'queued' && current.status !== 'streaming';
  const incomingIsTerminal = incoming.status !== 'queued' && incoming.status !== 'streaming';
  if (currentIsTerminal && !incomingIsTerminal) return current;
  if (!currentIsTerminal && incomingIsTerminal) return incoming;
  const currentTextLength = current.contentText.length + current.thoughtsText.length;
  const incomingTextLength = incoming.contentText.length + incoming.thoughtsText.length;
  if (
    currentTextLength > incomingTextLength ||
    (current.activity?.length ?? 0) > (incoming.activity?.length ?? 0) ||
    (current.status === 'streaming' && incoming.status === 'queued')
  ) {
    return current;
  }
  return incoming;
}

export function upsertMessage(messages: MessageRecord[], incoming: MessageRecord): MessageRecord[] {
  const existingIndex = messages.findIndex((message) => message.id === incoming.id);
  if (existingIndex === -1) return [...messages, incoming];
  const next = messages.slice();
  next[existingIndex] = newerMessage(messages[existingIndex], incoming);
  return next;
}
