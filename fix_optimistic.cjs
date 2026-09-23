const fs = require('fs');
let code = fs.readFileSync('src/components/leads/QuoPhoneTrigger.tsx', 'utf8');

const regex = /\s*\/\/\s*Optimistically add message to stream\s*const optimisticMsg: QuoChatMessage = \{\s*id: tempId,\s*to: \[normalizedPhone\],\s*from: "agent",\s*text: content,\s*phoneNumberId: conversationMeta\?\.quoPhoneNumberId \|\| "",\s*conversationId: conversationMeta\?\.id,\s*direction: "outgoing",\s*status: "pending",\s*createdAt: nowIso,\s*\};\s*setMessages\(\(current\) => mergeQuoMessages\(\[\.\.\.current, optimisticMsg\]\)\);/g;

code = code.replace(regex, "");
fs.writeFileSync('src/components/leads/QuoPhoneTrigger.tsx', code);
