const fs = require('fs');
let code2 = fs.readFileSync('src/components/leads/QuoPhoneTrigger.tsx', 'utf8');
const regex2 = /realtimeBus\.removeEventListener\("quo_outbound_messages", handleQuoOutboundMessages\);/g;
if (regex2.test(code2)) {
    code2 = code2.replace(regex2, "");
    fs.writeFileSync('src/components/leads/QuoPhoneTrigger.tsx', code2);
    console.log("Success QuoPhoneTrigger removeEventListener");
} else {
    console.log("Regex didn't match QuoPhoneTrigger removeEventListener");
}
