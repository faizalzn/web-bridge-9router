import { randomBytes } from 'node:crypto';

const rand = (n = 12) => randomBytes(n).toString('hex');
export const newId = {
  chatCompletion: () => `chatcmpl-${rand()}`,
  message: () => `msg_${rand()}`,
  toolCall: () => `call_${rand()}`,
  toolUse: () => `toolu_${rand()}`,
};
