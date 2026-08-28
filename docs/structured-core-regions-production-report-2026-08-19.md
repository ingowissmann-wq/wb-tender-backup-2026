# Abschlussbericht: strukturierte Kernregionen

Stand: 2026-08-19 (UTC)

## Ergebnis

Die strukturierte Kernregionskonfiguration, die strikte Gesellschafts-/Leistungsbereichstrennung und die aktive Versionsbindung der Management-Inbox sind produktiv ausgerollt. Bestehende A08/A09/A10-Werte wurden nicht verändert. Der Cleanup für abgelaufene Ausschreibungen wurde weder verändert noch ausgeführt.

Aktiver Release:

- Image: `wb-tender-real-operations:20260819-structured-regions.5`
- Image-ID: `sha256:8047633b9375294dcefbd51dd781353381d0a14c45a4e14870e98f26518fc66f`
- Artefakt-Fingerprint: `a3c76925caba0107f5c1b035dbe53e7da64957f1e18b8b12adc793c71e95b3c4`
- Produktivcontainer: `wb-tender-public-ingestion-visibility-production-20260817`

## Fehlerursache

1. A08/A09/A10 waren ausschließlich Freitextwerte. Der Parser besaß keine persistierte, validierte Orts-/PLZ-/Radiusstruktur und konnte Leistungsorte nicht beweissicher gegen eine aktive Regionsversion binden.
2. Die Versionshistorie wurde zunächst global geladen und erst anschließend im Anwendungscode eingeschränkt. Tenant, Gesellschaft, kanonischer Leistungsbereich, Profil und Version waren nicht als gemeinsamer Datenbankscope modelliert.
3. Regionsergebnisse und Inbox-Zeilen enthielten keine vollständigen Scope-Schlüssel. Die Inbox verwendete das jeweils letzte Ergebnis einer Gesellschaft und nicht zwingend die aktive A08-/Regionsversion.
4. Mehrere oder fehlende Leistungsorte konnten in Altpfaden zu großzügig behandelt werden. Der Auftraggeberstandort war nicht überall technisch als unzulässiger Ersatz ausgeschlossen.
5. Schnelle Filterwechsel konnten ältere Browserantworten nach einem neueren Request rendern.

## Änderungen

- Neue strukturierte Regionszeilen für `PLACE_RADIUS`, `POSTAL_CODE`, `NUTS` und `STATE` mit Hinzufügen/Entfernen, Ort, PLZ, Bundesland, Radius, kanonischem NUTS-Code und Validierungsstatus.
- Fail-closed Ort-/PLZ-Prüfung gegen eine externe Referenz: exakt ein Treffer ist erforderlich; nicht auflösbare oder mehrdeutige Werte bleiben `INVALID` und können nicht aktiviert werden.
- NUTS-Prüfung gegen die GISCO-NUTS-2024-Referenz; Bundesländer werden kanonisch auf NUTS-1 abgebildet.
- Verständliche Aktivierungsvorschau mit normalisiertem Ort, PLZ, NUTS, Radius, Gesellschaft, Leistungsbereich, Profilversion und betroffener Konfigurationsversion. Der Vorschau-Checksum muss bei Aktivierung noch passen.
- Neue exakte Scopes aus `tenant_id`, `company_id`, `canonical_service`, `profile_id` und aktiver Regionsversion. Versionshistorie, Detail, Parameterstatus, Audit und Security-Kosten lesen serverseitig im exakten Scope.
- Strikte Scope- und RLS-Policies für Konfiguration, Regionsversionen, Regionsergebnisse und Inbox.
- Management-Inbox und Worker verwenden ausschließlich die aktive A08-/strukturierte Regionsversion des Gesellschaft-/Gewerk-Scopes. Fehlende A08 bleibt sichtbar, aber ausschließlich als Prüfgruppe.
- `CORE_REGION` wird nur bei belastbarer Regelübereinstimmung geliefert. Fehlende Leistungsorte werden `REGION_UNRESOLVED`, mehrere Leistungsorte `MULTI_REGION_REVIEW`; der Auftraggeberstandort wird nicht als Ersatz verwendet.
- Browserrequests werden bei Filterwechsel abgebrochen und zusätzlich durch eine Sequenznummer gegen verspätete Antworten geschützt. Formular, Historie, Status und Ergebnisse werden neu geladen.
- Bestehende Workflowstatus und verantwortliche Benutzer werden bei Inbox-Neumaterialisierung übernommen; Kundenentscheidungen werden nicht überschrieben.
- Bestehende Freitext-, Bundesland- und NUTS-Werte bleiben aktiv und unverändert, bis ein Administrator bewusst eine validierte strukturierte Version aktiviert.

Produktive Scopes:

| Gesellschaft | Kanonisches Gewerk | Profil | Versionen |
|---|---|---|---:|
| WB-Security GmbH | security | `47496a61-2a4c-49e5-a8a2-7c9793d4f054` | 53 |
| WB-Cleaning GmbH | cleaning | `447c8ef1-39e2-4ec0-a053-0dadd5b01e0b` | 76 |
| WB-Facilitys GmbH | facility_management | `ead40eff-0721-4266-81ff-f141b28cc442` | 0 |
| WB-Sicherheitstechnik GmbH | sicherheitstechnik | `2dbd02a0-c5be-4ca6-983f-7db2fa7b73a0` | 0 |
| WB-Emergency Service GmbH | emergency_services | `bc8219b6-24c5-43e7-a336-54f72b45b9c8` | 0 |

## Tests und Dry-Run

- Vollsuite: 235/235 bestanden, 0 fehlgeschlagen, 0 übersprungen.
- Gezielte strukturierte Regions-/Inbox-Suite: 39/39 bestanden.
- Abgedeckt: Gesellschafts- und Gewerktrennung, Versionshistorie, eindeutiger Ort/PLZ, mehrdeutiger Ort, Radius innen/außen, NUTS/Bundesland, fehlender und mehrfacher Leistungsort, Kernregionfilter, schnelle Filterwechsel, Tenant/RLS, fünf produktive Gewerke und Idempotenz.
- Reale, nicht aktivierende Referenzprüfung: Karlsruhe + 76131 + 25 km => `PLACE_POSTAL_UNIQUE`, PLZ 76131, NUTS DE1, Referenz `R907169`.
- Produktionsschema und relevante Daten in isoliertem PostgreSQL-Klon wiederhergestellt: 129 Versionen, 50.062 Regionsergebnisse, 8.632 Inbox-Zeilen.
- Migration 095 wiederholt angewandt: idempotent; 129/129 Versionen vollständig gescopet.
- RLS-Praxistest: korrekter Tenant sieht 5 Scopes, fremde Tenant-ID sieht 0.
- Rollback 095 praktisch ausgeführt: 129 Versionen, 50.062 Regionen und 8.632 Inbox-Zeilen erhalten; neue Tabellen/Spalten vollständig entfernt.
- Migration 096 und ihr Einzelrollback praktisch ausgeführt und erneut angewandt.
- Authentifizierter Canary mit MFA-markierter, nur im Klon existierender Testsession: Konfigurationsseite/API 200, fünf Gewerke vorhanden, Security 53 ausschließlich eigene Versionen, Cleaning 76 ausschließlich eigene Versionen, Gesellschaft/Gewerk-Mismatch 422.
- Produktive Neumaterialisierung: Run `c9188716-5890-46b5-8cc3-4754a9477c3d`, 5.436 Kontexte, 5.436 Regions- und Inbox-Ergebnisse.
- Produktiver Idempotenzlauf: Run `ccc8c541-a928-4332-9de1-b7d1d8961ad6`, 5.436 geprüft, `inboxCreated=0`, `regionCreated=0`, `skipped=0`.

## Produktivprüfung

- Interner `/healthz`: HTTP 200.
- Externer `https://admin.wb-holding.ag/api/tender/healthz`: HTTP 200 über den unveränderten Reverse Proxy.
- Finales Image verifiziert 89 Pflichtartefakte und den erwarteten Fingerprint.
- Aktiver Bestandschecksum A08/A09/A10 vor und nach Rollout identisch: `e62552dddd80befd74be04d0ada8e38222f96aa4ef9e3523b4dbb9cc3db31b3e`.
- Aktive strukturierte Regionsversionen: 0. Es wurden keine erfundenen Orts-/Radiuswerte aktiviert.
- Aktueller Regionsguard: 0 `CORE_REGION`; 12.495 ungeklärte/mehrdeutige Konfliktfälle in Prüfklassen; 435 außerhalb; 47 strategisch. Der Kernregionfilter kann deshalb aktuell korrekt leer sein.
- Ein bestehender produktiver Administrator-Sessiontoken stand der Ausführungsumgebung nicht zur Verfügung. Gemäß Änderungsverbot für Login/MFA/Benutzer/Rollen wurde produktiv keine Testsitzung erzeugt. Der authentifizierte HTTP-Pfad wurde mit dem unveränderten finalen Image im isolierten Produktionsschema-Klon geprüft; Live-HTTPS, Live-Daten und Live-Scopeabfragen wurden getrennt geprüft.

## Backup und Rollback

Backup-Verzeichnis: `/root/wb-tender-backups/structured-regions-20260819T-current`

- Aktives Vorher-Image: `active-image.tar`, SHA-256 `be29ae330df83a0fdcf6c859d675d6b8ed94b3ea5473499ca3950c327b0d8c02`
- Profil-/Versions-/Regions-/Inbox-Backup: `tender-core-tables.dump`, SHA-256 `81b73b88180a03a807fe81c089d22e4d6d73707b167b220e8e1b4a848eb579ce`
- Schema: `production-schema.dump`
- Migrationsfixture: `migration-fixture.dump`
- Laufzeitmetadaten: `active-container-inspect.json`, `active-image-inspect.json`
- SQL-Rollback: `deployment/rollback-unconfigured-region-review-scope.sql`, danach `deployment/rollback-structured-core-regions.sql`
- Sofortiger Containerrollback: `wb-tender-public-ingestion-visibility-rollback-pre-structured-20260819` mit `wb-tender-real-operations:20260819-expiry-fail-closed.9`; zusätzliche laufende Zwischenstufen `.2`, `.3` und `.4` sind vorhanden.

Der Reverse Proxy, Admin-Login/MFA, Benutzer, Rollen, Berechtigungen, Quellenimport, Klassifizierungsregeln, Ausschreibungs-Cleanup, Career, Website, SaaS/Auth0 sowie andere Datenbanken und Volumes wurden nicht verändert.
