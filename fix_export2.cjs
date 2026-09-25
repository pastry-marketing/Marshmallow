const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const regexExport = /"Number Name": lead\?\.number_name \|\| "",/g;
const newExport = `"Number Name": lead?.number_name || "",
            "Source URL": lead?.source_url || "",
            "Cancellation Reason": lead?.cancellation_reason || "",
            "Total Amount": lead?.amount || "",
            "Labor Amount": lead?.labor_amount || "",
            "Material Amount": lead?.material_amount || "",
            "For You Amount": lead?.for_you_amount || "",
            "For Us Amount": lead?.for_us_amount || "",
            "Scheduled Date": lead?.scheduled_date || "",
            "Last Edited At": lead?.last_edited_at ? new Date(lead.last_edited_at).toLocaleString() : "",`;

if (regexExport.test(code)) {
    code = code.replace(regexExport, newExport);
    fs.writeFileSync('src/pages/LeadsPage.tsx', code);
    console.log("Success");
} else {
    console.log("Regex didn't match");
}
