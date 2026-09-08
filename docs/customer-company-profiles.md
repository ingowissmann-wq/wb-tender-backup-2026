# Unternehmensgrundlagen im Kundenportal

Nach bezahlter Erstaktivierung steht die registrierte Gesellschaft unter „Gesellschaften“ bereit. Weitere Gesellschaften lassen sich innerhalb der Paketgrenze anlegen. Wiederholte Anlageanfragen erzeugen keine doppelte Gesellschaft.

Unter „Leistungs- und Kalkulationsgrundlagen“ wählen Eigentümer oder Administratoren Gesellschaft, Leistungsart und Gültigkeitszeitraum. Unterstützt sind Gebäudereinigung, Sicherheitsdienst und Facility Management. Regionen werden als Bundesland, amtliches NUTS-Gebiet, Postleitzahl oder Ort mit Umkreis erfasst. Nicht eindeutig validierbare Orte und Regionen können nicht aktiviert werden.

Alle C01–C21-Werte benötigen eine zulässige Einheit, eine Quelle und eine ausdrückliche fachliche Bestätigung. Für Sicherheitsdienst kommen S01–S04 hinzu. Es gibt keine vorgegebenen Geld- oder Prozentwerte; auch Nullwerte müssen ausdrücklich angegeben werden. Zuschläge werden getrennt nach Nacht, Sonntag und Feiertag erfasst. Der gemeinsame Gültigkeitszeitraum gilt für die im Formular eingegebenen Quellen; die API unterstützt zusätzlich engere Gültigkeitszeiträume pro Parameter.

Jede Speicherung erzeugt eine neue, unveränderliche Version. Historische Versionen werden nicht überschrieben oder gelöscht. Zum Berechnungsdatum wird die jüngste zu diesem Zeitpunkt gültige Version gewählt; eine erst künftig gültige Änderung beeinflusst frühere Kalkulationen nicht. Alle Vorgänge bleiben mandanten- und gesellschaftsgebunden und werden auditiert.

Die Profilverwaltung stellt freigegebene Grundlagen für die bestehende Kalkulationsengine bereit. Sie ist noch kein Nachweis des vollständigen automatischen Kundenablaufs von einem neu importierten Los bis zum Managementbeschluss und Angebotspaket. Dieser Ablauf benötigt eine eigene integrierte Abnahme.
