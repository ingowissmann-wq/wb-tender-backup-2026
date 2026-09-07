# WB-Tender-Produktionsmonitor

`deployment/wb-tender-production-monitor` ruft den benachbarten Python-Monitor auf. Beide Dateien werden zusammen aus dem freigegebenen Release installiert. Der Monitor verändert keine Container, Geschäftsdaten oder Backups und führt keinen Datenbank-Restore aus.

Er prüft ausschließlich die vier `wb-tender-production`-Dienste und die Domains `wb-tender.com`, `www.wb-tender.com`, `www.enwi.online`. Er erkennt abweichende Compose-Projekte, unterschiedliche API-/Worker-/Scheduler-Images, Neustarts, ungesunde Dienste und aktivierte externe Übermittlungsflags. Öffentliche Routen müssen mit gültigem TLS erreichbar sein; Weiterleitungen außerhalb der freigegebenen Domains werden abgelehnt.

Datenbankprüfungen laufen mit `BEGIN READ ONLY` und Zeitlimit über den eindeutig identifizierten Compose-Datenbankclient. Der Bericht enthält nur Zähler für E-Mail-Fehler, überfällige E-Mails, wartende/überfällige Aufträge, fehlgeschlagene Aufträge, Login- und Zahlungsfehler sowie veraltete DOE-/TED-Importe. Fehlende neue Tabellen sind ein Fehler, kein grüner Ersatzwert.

Die Sicherung muss einen höchstens 30 Stunden alten, checksumgeprüften Manifestnachweis einer Katalogprüfung besitzen. Der Monitor liest nicht bei jedem Lauf erneut das gesamte verschlüsselte Archiv und ersetzt keinen Restore-Test. Der tägliche Backup-Timer muss aktiv und aktiviert sein. Unter 15 Prozent freiem Speicher wird alarmiert; Aufbewahrung und Kapazität sind vor weiteren großen Sicherungen zu prüfen.

Der atomar geschriebene Bericht liegt geschützt unter `/var/lib/wb-tender-production-monitor/current.json`. Fehler führen zu Exit 1 und einer Meldung im Systemjournal. Externe Alarmzustellung, regelmäßiger Timerbetrieb, Wiederherstellungstests und 30 Minuten Überwachung nach Cutover müssen zusätzlich produktiv nachgewiesen werden; die bloße Existenz dieses Skripts erfüllt diese Abnahme nicht.
