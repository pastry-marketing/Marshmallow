const fs = require('fs');
let code = fs.readFileSync('src/lib/quo-chat.ts', 'utf8');

const regex = /\/\/\s*Include messages queued for the extension that haven't been echoed back by the webhook yet\.[\s\S]*?const queued:\s*QuoChatMessage\[\]\s*=\s*\(outbound \?\? \[\]\)\.map\(\(row\) => \(\{[\s\S]*?\}\)\);/g;

if (regex.test(code)) {
    code = code.replace(regex, "const queued: QuoChatMessage[] = [];");
    fs.writeFileSync('src/lib/quo-chat.ts', code);
    console.log("Success quo-chat");
} else {
    console.log("Regex didn't match quo-chat");
}

let code2 = fs.readFileSync('src/components/leads/QuoPhoneTrigger.tsx', 'utf8');
const regex2 = /realtimeBus\.addEventListener\("quo_outbound_messages", handleQuoOutboundMessages\);/g;
if (regex2.test(code2)) {
    code2 = code2.replace(regex2, "");
    fs.writeFileSync('src/components/leads/QuoPhoneTrigger.tsx', code2);
    console.log("Success QuoPhoneTrigger");
} else {
    console.log("Regex didn't match QuoPhoneTrigger");
}
