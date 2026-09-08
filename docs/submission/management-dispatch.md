# Managementfreigabe und dauerhafte Portalabgabe

Dieser inkrementelle Quellstand ergänzt den Produktionsstand d178f0f9374cd288da2684e428d80507a2471250. Die Implementierung und ihre isolierten Nachweise ersetzen keine Validierung bei einem echten Portalbetreiber. Ein lokales Testportal darf niemals als produktiv validierter Anbieter eingetragen werden.

Die ausdrückliche, mit frischer TOTP-Sitzung bestätigte Freigabe speichert einen unveränderlichen Mandanten-, Gesellschafts-, Los-, Portal-, Frist-, Kalkulations- und Dokumentenbezug. Ein SHA-256 bindet das Angebotspaket. Freigabe und Jobanlage erfolgen in derselben Datenbanktransaktion. Vorhandene Paketprüfungen, Abonnements, Nutzungsgrenzen, Kalkulationen und Dokumentenverarbeitung bleiben erhalten.

`submission_dispatches` enthält die Zustände DRAFT → READY_FOR_MANAGEMENT → MANAGEMENT_APPROVED_FOR_SUBMISSION → SUBMISSION_QUEUED → SUBMITTING → SUBMITTED. Fehlerzustände sind RETRY_REQUIRED, MANUAL_INTERVENTION_REQUIRED, DEADLINE_EXPIRED, CREDENTIALS_REQUIRED und PORTAL_CHANGED. Ein identischer Mandant, dieselbe tatsächliche Gesellschaft, Ausschreibung und dasselbe Los reservieren denselben Abgabeumfang auch über die beiden Benutzeroberflächen hinweg.

Der separate Dienst startet mit `node platform/submission-worker-service.mjs`. Er verwendet einen eigenen Datenbank-Login mit Mitgliedschaft in `tender_submission_worker_runtime`. Die Verbindung bleibt während eines Jobs geöffnet und hält die PostgreSQL-Advisory-Sperre. Eine ablaufende Lease wird erneuert. Nach persistierter Finalisierungsabsicht ist kein erneuter finaler Portalaufruf erlaubt. Ein verlorenes Ergebnis darf ausschließlich lesend abgeglichen werden; andernfalls bleibt der Vorgang zur manuellen Prüfung gesperrt.

Der Browseradapter verwendet die bestehende Anmeldung. Ein versioniertes, an Host, Adapterversion und ausführbaren Code gebundenes Profil beschreibt Zielprüfung, Upload, kontrollierte Formularwerte, Finalisierung und Empfangsbeleg. Vor dem Senden werden die hochgeladenen Dateien erneut heruntergeladen und mit dem freigegebenen Manifest verglichen. Unerwartete Hosts, Schreibendpunkte, Dokumente oder Oberflächenzustände stoppen die Verarbeitung. Fehlende Eingaben erhalten keine erfundenen Ersatzwerte. Portale, die proprietäre signierte oder verschlüsselte Bieterpakete voraussetzen, benötigen dafür nachgewiesene Unterstützung; ein allgemeines ZIP ist kein Ersatz.

Produktive Profile benötigen Login-, Ziel-, Upload-, Finalisierungs- und Belegnachweise aus einem vom Betreiber vorgesehenen nicht bindenden Verfahren. Diese Anforderungen gelten für jeden Host separat. `submission_adapter_releases` bleibt ohne solche Nachweise deaktiviert. Der technische Publikationsdienst TED wird nicht als Abgabeportal behandelt.

API, bisheriger Worker, Scheduler und Submission-Worker verwenden denselben Release-Digest und dieselben beiden Abgabeschalter. Bei Aktivierung ist zusätzlich `SUBMISSION_EXECUTION_MODE=DEDICATED_VALIDATED_WORKER` erforderlich. Der Submission-Worker prüft auch die Datenbankschalter und portalbezogene Freigabe unmittelbar vor Schreibaktionen. Die übrigen Dienste führen keine Angebotsübertragung aus.

Erforderliche dateibasierte Konfiguration des Submission-Workers:

- `SUBMISSION_DATABASE_URL_FILE`
- `SAAS_PORTAL_CREDENTIAL_KEYRING_FILE`, `PORTAL_CREDENTIAL_KEY_FILE`
- `WB_TENDER_TENANT_STORAGE_ROOT`
- bestehende `SAAS_SMTP_*_FILE` und `SAAS_PUBLIC_BASE_URL`
- `RELEASE_COMMIT`, `EXTERNAL_SUBMISSION_ENABLED`, `WB_TENDER_ALLOW_EXTERNAL_SUBMISSION`, `SUBMISSION_EXECUTION_MODE`

`/healthz` auf dem eigenen Worker-Port liefert Heartbeat sowie Zähler für Warteschlange, bevorstehende Fristen, Portalfehler, abgebrochene Uploads, fehlende Belege, Benachrichtigungen und erkannte Wiederholungsversuche. Statuswechsel erzeugen atomar Portalbenachrichtigungen und einen SMTP-Ausgang. SMTP-Fehler werden mit festem Fehlercode erneut versucht; Zugangsdaten werden nicht protokolliert.

Die Neueingabemaske ist in `/admin/ausschreibungen/autopilot/portal-access` eingebettet und zusätzlich unter `/admin/ausschreibungen/portalzugang-neueingabe` erreichbar. Sie zeigt im freigegebenen Gesellschaftsbereich nur nicht entschlüsselbare Zugänge mit `CREDENTIALS_REQUIRED`. Sie fragt ausschließlich neue Zugangsdaten ab. Der ursprüngliche verschlüsselte Datensatz bleibt erhalten; ein neuer Datensatz wird gespeichert, unmittelbar zurückgelesen und über eine unveränderliche Historie zugeordnet. Die 14 produktiven Altzugänge können erst nach tatsächlicher Neueingabe wieder verwendet werden. Vor Verwendung prüft der Submission-Worker zusätzlich Ablaufdatum und Hostbindung eines Altzugangs.

Ein als nicht erreichbar erkanntes Portal führt vor Finalisierungsabsicht zur begrenzten Wiederholung, ohne eine Passwortneueingabe zu verlangen. Nicht nachgewiesene Dokumentenberechtigungen oder unbekannte Loginfehler werden nicht als falsche Passwörter dargestellt. Service Worker sind im Abgabebrowser deaktiviert, damit Schreibaktionen die Phasenprüfung nicht umgehen können.

Vor einer produktiven Migration müssen verschlüsseltes Backup und Rücksprungpunkt geprüft sein. Ein Rücksprung auf den bisherigen Digest erhält das additive Schema und alle neuen Freigaben, Belege und Zugangshistorien. Die Down-Migration verweigert das Entfernen, sobald solche Daten vorliegen. Keine Migration oder Umschaltung darf fehlende Anbietervalidierung oder fehlgeschlagene Regressionstests übergehen.
