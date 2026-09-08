# Mitarbeiterportal und Onboarding

Eigentümer und Administratoren verwalten unter `/saas/app/people` Mitarbeiterprofile. Neue Profile können mit einem aktiven Benutzerkonto des eigenen Mandanten verbunden werden. Diese Benutzerbindung bleibt unverändert. Die Personalverwaltung erteilt keinen zusätzlichen Lizenzzugang; Benutzeraktivierung und Paketgrenzen werden separat über Mitgliedschaften durchgesetzt.

Profile können angelegt und geändert werden. Veraltete Bearbeitungsstände werden zurückgewiesen. Jede Anlage und Änderung wird auditiert; private E-Mail-Adressen werden dabei nicht zusätzlich in das allgemeine Audit kopiert. Wiederholte identische Anlageanfragen erzeugen kein zweites Profil. Eine bisherige fehlerhafte Referenz auf die nicht vorhandene Spalte `employee_profiles.updated_at` wurde durch die vorhandene PostgreSQL-Revision und das Audit ersetzt.

Onboardingaufgaben werden einem eigenen Mitarbeiterprofil und optional einem aktiven Verantwortlichen zugeordnet. Fristen werden ausdrücklich eingegeben. Der Verantwortliche sowie Eigentümer und Administratoren können mit Begründung und Bestätigung den Status Offen, Erledigt oder Nicht erforderlich setzen. Andere Mitglieder können keine fremden Aufgaben abschließen. Änderungen prüfen die vorher gelesene Revision.

Normale Mitglieder gelangen unter `/saas/app/me` zu ihrem eigenen Profil und ihren eigenen oder zugewiesenen Aufgaben. Listen, Detailzugriff und Export fremder Personalakten sind für sie gesperrt, auch über die allgemeinen Modulrouten. Personalverwaltung und Mitarbeiterportal benötigen ein aktives Paket beziehungsweise einen noch laufenden Testzugang mit dem Modul People.

Der Ablauf umfasst Profile und Onboardingaufgaben. Lohnabrechnung, automatische Erinnerungs-E-Mails und ein vollständiger Urlaubsantragsprozess werden damit nicht behauptet.
