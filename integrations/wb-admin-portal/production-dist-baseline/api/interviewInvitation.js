const placeholders = [
    "anrede",
    "vorname",
    "nachname",
    "vollstaendiger_name",
    "email",
    "datum",
    "uhrzeit",
    "endzeit",
    "dauer",
    "stellenbezeichnung",
    "teams_link",
    "bewerbungs_id",
    "termin_id",
    "ansprechpartner",
];
export const defaultInterviewSubject = "Einladung zum Vorstellungsgespräch – {{stellenbezeichnung}} – WB Holding AG";
export const defaultInterviewText = `{{anrede}}

vielen Dank für Ihre Bewerbung und Ihr Interesse an einer Mitarbeit in unserem Unternehmen.

Gerne möchten wir Sie zu einem persönlichen Vorstellungsgespräch per Microsoft Teams einladen.

Das Gespräch findet zu folgendem Termin statt:

Datum: {{datum}}
Uhrzeit: {{uhrzeit}}
Position: {{stellenbezeichnung}}
Dauer: ca. {{dauer}} Minuten
Ansprechpartner: {{ansprechpartner}}

Über den folgenden Link können Sie an dem Gespräch teilnehmen:

Microsoft-Teams-Link:
{{teams_link}}

Bitte bestätigen Sie uns kurz, ob Sie den vorgeschlagenen Termin wahrnehmen können. Sollte der Termin für Sie nicht möglich sein, bitten wir Sie um Mitteilung geeigneter Alternativtermine.

Wir freuen uns darauf, Sie kennenzulernen und mehr über Ihren bisherigen beruflichen Werdegang sowie Ihre Motivation zu erfahren.

Mit freundlichen Grüßen

Ihr Recruiting Team
WB Holding AG

Am Spielberg 6
86316 Friedberg (BY)

Telefon: +49 8205 46 49 888
Mobil: +49 1523 13 806 39
E-Mail: bewerbung@wb-holding.ag
Web: www.wb-holding.ag

Vorstand: Ingo Wissmann
Vorsitzender des Aufsichtsrats: Ramazan Bland
Sitz der Gesellschaft: Friedberg
Registergericht: Amtsgericht Augsburg, HRB 42425
USt-IdNr.: DE460662472


Diese E-Mail könnte vertrauliche und/oder rechtlich geschützte Informationen enthalten.
Wenn Sie nicht der richtige Adressat sind oder diese E-Mail irrtümlich erhalten haben,
informieren Sie bitte sofort den Absender und vernichten Sie diese E-Mail einschließlich
möglicher Anhänge und sämtlicher Kopien. Das unerlaubte Nutzen, Kopieren, Offenlegen sowie
die unbefugte Weitergabe dieser E-Mail, der darin enthaltenen Informationen oder Teile davon
ist nicht gestattet und kann eine rechtswidrige Handlung darstellen.

This e-mail may contain confidential and/or privileged information. If you are not the intended
recipient or have received this e-mail in error please notify the sender immediately and destroy
this e-mail including all attachments and any copies. Any unauthorized use, copying, disclosure
or distribution of this communication or parts thereof is strictly prohibited and may be unlawful.`;
export function validTeamsUrl(value) {
    try {
        const url = new URL(String(value || "").trim());
        return (url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].includes(url.hostname.toLowerCase()));
    }
    catch {
        return false;
    }
}
export function salutation(kind, first, last) {
    const surname = String(last || "").trim();
    if (kind === "Frau")
        return `Sehr geehrte Frau ${surname},`;
    if (kind === "Herr")
        return `Sehr geehrter Herr ${surname},`;
    return `Guten Tag ${[first, last].map((x) => String(x || "").trim()).filter(Boolean).join(" ")},`;
}
function berlin(value, options) {
    return new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        ...options,
    }).format(value);
}
export function invitationValues(application, invitation) {
    const start = new Date(invitation.start);
    const end = new Date(invitation.end);
    const duration = Math.round((end.getTime() - start.getTime()) / 60000);
    return {
        anrede: salutation(invitation.salutation, application.firstName, application.lastName),
        vorname: String(application.firstName || ""),
        nachname: String(application.lastName || ""),
        vollstaendiger_name: `${application.firstName || ""} ${application.lastName || ""}`.trim(),
        email: String(application.email || ""),
        datum: berlin(start, { day: "2-digit", month: "2-digit", year: "numeric" }),
        uhrzeit: berlin(start, { hour: "2-digit", minute: "2-digit" }),
        endzeit: berlin(end, { hour: "2-digit", minute: "2-digit" }),
        dauer: String(duration),
        stellenbezeichnung: String(application.jobTitleSnapshot || application.jobTitle || "Bewerbung"),
        teams_link: String(invitation.teamsLink || ""),
        bewerbungs_id: String(application._id || ""),
        termin_id: String(invitation.id || ""),
        ansprechpartner: String(invitation.contact || "WB-Holding Recruiting"),
    };
}
export function renderTemplate(template, values) {
    let rendered = String(template || "");
    for (const key of placeholders)
        rendered = rendered.replaceAll(`{{${key}}}`, values[key] || "");
    if (/{{[^{}]+}}/.test(rendered))
        throw new Error("unresolved_placeholder");
    return rendered;
}
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
})[character]);
export function invitationHtml(text, teamsLink) {
    if (!validTeamsUrl(teamsLink) || !text.includes(teamsLink))
        throw new Error("teams_link_missing");
    const escaped = escapeHtml(text).replace(/\n/g, "<br>");
    const anchor = `<a href="${escapeHtml(teamsLink)}" style="display:inline-block;background:#174a7e;color:#fff;padding:12px 18px;border-radius:4px;text-decoration:none;font-weight:600">An Microsoft-Teams-Besprechung teilnehmen</a>`;
    return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif;color:#1c2733"><div style="max-width:680px;margin:auto;background:#fff;padding:28px"><div style="border-left:4px solid #174a7e;padding-left:20px;line-height:1.55">${escaped.replace(escapeHtml(teamsLink), `${anchor}<br><br><a href="${escapeHtml(teamsLink)}">${escapeHtml(teamsLink)}</a>`)}</div></div></body></html>`;
}
