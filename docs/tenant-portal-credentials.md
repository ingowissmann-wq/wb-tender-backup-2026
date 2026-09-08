# Mandantenbezogene Portalzugänge

`/saas/app/portal-access` speichert einen Zugang je Gesellschaft und registriertem Vergabeportal. Nur OWNER und ADMIN mit aktivem Autopilot-Zugang können die Seite und API nutzen. Mutationen benötigen den bestehenden CSRF-Nachweis. Gesellschaften stammen ausschließlich aus dem eigenen Mandanten; Portale aus dem zentralen Register. Die API liefert Bezeichnung, Bindung, Zeitstempel und Versionsnummern, niemals Benutzername, Passwort oder Chiffretext. Speicherung bedeutet noch keine erfolgreiche Anmeldung am Fremdportal.

Die Konfiguration verwendet ausschließlich `SAAS_PORTAL_CREDENTIAL_KEYRING_FILE`: eine reguläre Datei mit Modus 0600 und JSON-Struktur `{ "active": "v1", "keys": { "v1": "<32 zufällige Bytes in kanonischem Base64>" } }`. Die Datei wird ohne Folgen eines finalen Symlinks geöffnet und per Dateideskriptor geprüft. Keine Schlüsselwerte in Compose-Umgebungsvariablen oder Logs schreiben. Sicherungen der Datenbank benötigen auch die weiterhin geschützten, separat gesicherten Schlüsselversionen.

AES-256-GCM verschlüsselt Benutzername und Passwort mit einem neuen 96-Bit-Nonce pro Speicherung. Der authentifizierte Kontext umfasst Mandant, Gesellschaft, Portal, Datensatz-ID, Revision und Schlüsselversion. Manipulation oder Übertragung des Chiffretexts auf einen anderen Kontext schlägt fehl. Die Tabelle erzwingt RLS, einen zusammengesetzten Gesellschafts-Fremdschlüssel und unveränderliche Bindungen. Speichern, unmittelbare Entschlüsselungsprüfung und Audit sind eine Transaktion. Änderungen benötigen die erwartete Revision; parallele veraltete Änderungen werden abgewiesen.

## Schlüsselrotation

Neue zufällige Schlüsselversion in eine geschützte temporäre Datei aufnehmen, bisherige Versionen behalten und die validierte Datei atomar ersetzen. Anschließend je eigenem Zugang `POST /api/tenant-portal/companies/:companyId/credentials/:id/rotate` mit `expectedRevision` und CSRF aufrufen. Rotation sperrt den Datensatz, entschlüsselt mit der bisherigen Version, verschlüsselt mit der aktiven Version und prüft die tatsächliche Rücklesung vor dem Commit. Der Vorgang erzeugt `PORTAL_CREDENTIAL_KEY_ROTATED`. Bereits auf der aktiven Version gespeicherte Zugänge bleiben unverändert. Alte Schlüssel erst nach nachgewiesener vollständiger Rotation und gemäß Aufbewahrung der verschlüsselten Backups außer Betrieb nehmen. Historische Backups bleiben auf ihre Schlüssel angewiesen.

## Rollback und Abnahmegrenzen

Migration 167 kann nur bei leerer Vault-Tabelle zurückgerollt werden. Ein Rückrollen mit Kundenzugängen bricht ab, statt diese zu löschen; dann zunächst kompatibles vorheriges Anwendungsimage einsetzen und Daten erhalten. Die Migration führt keine Übernahme aus alten, anders gebundenen Credential-Tabellen durch.

Die Kryptographie- und PostgreSQL-Regressionen prüfen Kontextmanipulation, Fremdmandanten, Fremdgesellschaften, Revisionsschutz, fehlende Schlüssel, Rotation und vollständigen leeren Schema-Rollback. Reale Fremdportal-Anmeldung, Sitzungsverwaltung, Unterlagenabruf und Persistenz über einen Serverneustart sind gesonderte Abnahmepunkte. Dieser Speicher aktiviert keine externe Angebotsübermittlung.
