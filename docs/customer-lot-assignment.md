# Lose und Gesellschaften

Unter **Lose bearbeiten** öffentliche Ausschreibungen suchen und über **Lose prüfen und übernehmen** in die eigene Bearbeitung übernehmen. Die Anwendung verwendet ausschließlich aktuell teilnahmefähige Lose und die gültigen Unternehmensgrundlagen des eigenen Mandanten.

Jedes Los erhält eine eigene Leistungs- und Regionsbewertung. Nur genau ein passendes Gesellschaftsprofil mit bestätigter Kernregion führt zur automatischen Zuordnung. Unvollständige Orte, mehrere passende Gesellschaften und nicht passende Regionen bleiben prüfpflichtig. Auftraggeberstandort und Orte anderer Lose sind keine Ersatzwerte.

Eigentümer und Administratoren können eine aufgeführte fachlich passende Gesellschaft ausdrücklich auswählen. Eine Begründung und Bestätigung sind erforderlich. Ausgeschlossene Regionen bleiben gesperrt. Die Entscheidung erzeugt eine neue Version und einen Audit-Eintrag.

Erneutes Übernehmen identischer Daten erzeugt keine neue Bewertung. Neue Quelldaten überschreiben keine Benutzerentscheidung: Die gespeicherte Gesellschaft bleibt erkennbar, die Entscheidung muss erneut geprüft werden. Historische Versionen bleiben erhalten.

Eine Loszuordnung ist noch keine Managementfreigabe eines Angebots. Sie löst keine externe Übermittlung aus.

## Betrieb und Abnahme

Migration 169 ergänzt eine ausschließlich appendierbare, RLS-geschützte Tabelle. Zusammengesetzte Fremdschlüssel binden Mandant, Bearbeitungsbereich, Gesellschaft und Profil; ein Trigger prüft den Bezug der Quellversion zur Ausschreibung. Die Rückwärtsmigration verweigert das Entfernen vorhandener Kundenzuordnungen.

Lokale Browserabnahme verwendet synthetische Ausschreibungen in einer isolierten Kopie des Produktionsschemas und die echte Runtime-Rolle. Sie ersetzt weder produktiven Dokumentenabruf noch Kalkulations-, Management- oder Angebotspaketabnahme.
