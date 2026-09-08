# Betrieb der mandantengebundenen Portalsitzungen

Migration 174 ergänzt `tenant_portal.portal_sessions`. Die Tabelle hat erzwungene RLS, einen zusammengesetzten Fremdschlüssel zum Mandanten-/Gesellschafts-/Portalzugang und unveränderliche Bindungen. Ergebnisse abgeschlossener Prüfungen lassen sich nicht ersetzen; eine Sitzung kann endgültig widerrufen werden.

Sitzungen verwenden AES-256-GCM mit dem File-Keyring `SAAS_PORTAL_CREDENTIAL_KEYRING_FILE`. Die authentifizierten Zusatzdaten enthalten einen eigenen Sitzungsnamensraum, Sitzungs-ID, Mandant, Gesellschaft, Portal, Zugang, Zugangsversion und Schlüsselversion. Der Keyring muss eine reguläre Datei mit 0600 sein. Geheimnisse dürfen nicht über Umgebungsvariablen, Compose-Inlinewerte oder Logs transportiert werden.

Bei Schlüsselrotation zuerst einen neuen aktiven Schlüssel zur Datei hinzufügen und die Zugänge über die vorhandene Rotation aktualisieren. Alte Sitzungen verlieren durch die neue Zugangsversion ihre Nutzbarkeit. Alte Schlüssel erst entfernen, wenn ihre Nutzung für zurückbehaltene Daten und Wiederherstellungen geklärt ist. Sicherungen und ihre Schlüssel erhalten.

Eine Prüfung schreibt zunächst `CHECKING` und ein Audit-Ereignis, bevor sie das Portal kontaktiert. Wiederholungen derselben Auftrags-ID erzeugen keinen zweiten Login. Nach einem Prozessabbruch darf ein alter `CHECKING`-Datensatz nicht als erfolgreicher Login interpretiert werden; eine neue explizite Prüfung benötigt eine neue ID. Ein ungeklärter Prüfstand und eine abgelaufene Sitzung gewähren keinen Sitzungzugriff.

Rollback verweigert das Entfernen der Tabelle, sobald Kundensitzungen vorhanden sind. Kundenhistorie wird nicht zur Erzwingung eines Rollbacks gelöscht. Die Anwendung stellt keine Cookies, Speicherzustände oder Zugangsdaten über öffentliche Routen bereit. Externe Übermittlung bleibt gesperrt.
