# Tägliche Produktionssicherungen

Der versionierte Dienst `wb-tender-production-backup.service` wird täglich zwischen 02:15 und 02:20 UTC über den gleichnamigen Timer ausgelöst. Die freigegebene Konfiguration liegt mit 0600 unter `/srv/wb-tender-production/backup-current/config.json`; sie bindet Client, PostgreSQL-Image, Anwendungsimage, Commit, Tree und vorhandene Secret-Dateipfade. Bei einem Releasewechsel muss diese Bindung kontrolliert aktualisiert werden.

Vor einem Dump werden Image-Labels, Projektbindung, File-Secrets und eine echte PostgreSQL-Anmeldung geprüft. Erforderlich sind 2,6-mal die aktuelle Datenbankgröße plus 20 GiB verfügbarer Platz: Reserve für einen neuen, gegebenenfalls schlecht komprimierbaren Dump, eine isolierte Wiederherstellung und laufenden Betrieb. Ohne diese Reserve beendet sich der Job vor der Sicherung mit `BLOCKED_CAPACITY`. Während der Sicherung überwacht er weiterhin eine Untergrenze von 20 GiB und ein Zeitlimit von vier Stunden.

`pg_dump` fließt direkt durch SHA-256 und GPG AES-256. Ein Klartextdump wird nicht auf dem Dateisystem gespeichert. Nach dem Dump werden Entschlüsselung und Klartexthash, der `pg_restore`-Katalog sowie Archiv- und Manifest-Prüfsummen geprüft. Der Job behält vorhandene Backups und auch fehlgeschlagene verschlüsselte Teilartefakte zur Untersuchung. Er löscht keine Sicherungen und führt keinen Restore über die Produktionsdatenbank aus.

Der geschützte Status liegt unter `/var/lib/wb-tender-production-backup/current.json`. Der Monitor unterscheidet einen laufenden Timer von einem tatsächlich bestandenen Backup. Kapazitätsblockaden, Fehler und veraltete Ergebnisse lösen die bestehende deduplizierte Alarmierung aus. Ein bestandener Archivcheck ist noch kein vollständiger Restoretest; die isolierte Wiederherstellung bleibt ein gesonderter Pflichtnachweis vor Migration und Cutover.

Ohne ausreichend Speicher oder einen zusätzlichen geeigneten Backup-Datenträger bleibt der Job blockiert. Ein aktiver Timer alleine ist kein Produktionsfreigabenachweis. Es gibt keine automatische Löschfrist: Kapazität und langfristige Aufbewahrung müssen vor der Liveschaltung abgesichert sein.
