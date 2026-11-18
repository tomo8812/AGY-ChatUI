import type { MessageRecord, ToolCallItem } from '../types';

type ActivityBlock =
  | { key: number; kind: 'thoughts' | 'commentary'; text: string }
  | { key: number; kind: 'tools'; tools: ToolCallItem[] };

export function getMessageActivity(message: MessageRecord): {
  blocks: ActivityBlock[];
  answer: string;
  hasCurrentAnswer: boolean;
} {
  const entries = message.activity ?? [];
  if (entries.length === 0) {
    // Earlier messages stored text and tools separately, without their order.
    const blocks: ActivityBlock[] = [];
    if (message.thoughtsText.trim()) {
      blocks.push({ key: 0, kind: 'thoughts', text: message.thoughtsText });
    }
    if (message.toolCalls.length) blocks.push({ key: 1, kind: 'tools', tools: message.toolCalls });
    return { blocks, answer: message.contentText, hasCurrentAnswer: Boolean(message.contentText.trim()) };
  }

  const toolsById = new Map(message.toolCalls.map((tool) => [tool.toolCallId, tool]));
  const blocks: ActivityBlock[] = [];
  const answers: string[] = [];
  let contentEnd = message.contentText.length;
  let thoughtsEnd = message.thoughtsText.length;
  // ACP uses the same message chunks for intermediate updates and the answer.
  // The trailing text is the current answer until more work arrives or ACP ends the response.
  let answerBoundary = true;
  let atCurrentEnd = true;
  let adjacentTools: ToolCallItem[] | undefined;
  let hasCurrentAnswer = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.kind === 'answer_end') {
      answerBoundary = true;
      adjacentTools = undefined;
      continue;
    }
    if (entry.kind === 'tool') {
      const tool = toolsById.get(entry.toolCallId);
      if (!tool) continue;
      const previous = blocks.at(-1);
      if (previous?.kind === 'tools' && adjacentTools === previous.tools) {
        previous.key = index;
        previous.tools.push(tool);
      } else {
        adjacentTools = [tool];
        blocks.push({ key: index, kind: 'tools', tools: adjacentTools });
      }
    } else if (entry.kind === 'thoughts') {
      const text = message.thoughtsText.slice(entry.offset, thoughtsEnd);
      thoughtsEnd = entry.offset;
      if (!text.trim()) continue;
      adjacentTools = undefined;
      blocks.push({ key: index, kind: 'thoughts', text });
    } else {
      const text = message.contentText.slice(entry.offset, contentEnd);
      contentEnd = entry.offset;
      if (!text.trim()) continue;
      adjacentTools = undefined;
      if (answerBoundary) {
        if (atCurrentEnd) hasCurrentAnswer = true;
        answers.push(text);
      } else {
        blocks.push({ key: index, kind: 'commentary', text });
      }
    }
    answerBoundary = false;
    atCurrentEnd = false;
  }

  blocks.reverse();
  for (const block of blocks) {
    if (block.kind === 'tools') block.tools.reverse();
  }
  return { blocks, answer: answers.reverse().join('\n\n'), hasCurrentAnswer };
}
