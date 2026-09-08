# Kunden und Kontakte

Business, Enterprise und der separate Kompletttest enthalten die Kunden- und Kontaktverwaltung unter `/saas/app/crm`. Pro hat keinen Zugriff. Alle Akten und Ansprechpartner gehören ausschließlich zum angemeldeten Mandanten.

Kundenakten enthalten einen Namen und den ausdrücklich gesetzten Vertriebsstand Interessent, Qualifiziert, Angebotsphase, Kunde oder Nicht gewonnen. Ansprechpartner gehören fest zu einer Kundenakte. Name und optionale E-Mail-Adresse können mit Begründung geändert werden. Gleichzeitige Änderungen werden über die gelesene Datenbankrevision geprüft; bei Konflikten muss der aktuelle Stand neu geladen werden. Wiederholte identische Anlageanfragen erzeugen keine zweite Akte. Jede Anlage und Änderung wird im Mandantenaudit gespeichert.

Die Suche durchsucht eigene Kundennamen. Bei mehr als 500 Treffern verlangt die Oberfläche eine engere Suche. Die Verwaltung verarbeitet interne Kundenakten; finanzielle Forecasts, eigenständige Opportunity-Beträge und automatische Vertriebs-E-Mails sind kein Bestandteil dieses Ablaufs.
