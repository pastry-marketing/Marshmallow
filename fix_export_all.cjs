const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const regexExport = /"Last Edited At": lead\?\.last_edited_at \? new Date\(lead\.last_edited_at\)\.toLocaleString\(\) : "",/g;
const newExport = `"Last Edited At": lead?.last_edited_at ? new Date(lead.last_edited_at).toLocaleString() : "",
            "System ID": lead?.id || "",
            "Customer Email": lead?.customer_email || "",
            "City": lead?.city || "",
            "State": lead?.state || "",
            "Zip Code": lead?.zip_code || "",
            "Half Address": lead?.half_address || "",
            "Scheduled Time Start": lead?.scheduled_time_start || "",
            "Scheduled Time End": lead?.scheduled_time_end || "",
            "Expected Completion Date": lead?.expected_completion_date || "",
            "Booked At": lead?.booked_at ? new Date(lead.booked_at).toLocaleString() : "",
            "Urgent At": lead?.urgent_at ? new Date(lead.urgent_at).toLocaleString() : "",
            "Updated At": lead?.updated_at ? new Date(lead.updated_at).toLocaleString() : "",
            "Last Edited By": lead?.last_edited_by_name || lead?.editor_name || lead?.last_edited_by || "",
            "Assigned CS": lead?.assigned_cs || "",
            "Quote Requested By": lead?.quote_requested_by || "",
            "Payment Amount": lead?.payment_amount || "",
            "Payment Screenshot URL": lead?.payment_screenshot_url || "",
            "Show Quote To OPR": lead?.show_quote_to_opr ? "Yes" : "No",`;

if (regexExport.test(code)) {
    code = code.replace(regexExport, newExport);
    fs.writeFileSync('src/pages/LeadsPage.tsx', code);
    console.log("Success");
} else {
    console.log("Regex didn't match");
}
