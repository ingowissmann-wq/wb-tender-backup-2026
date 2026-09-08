# Benutzer und Einladungen

Unter `/saas/app/control` sehen Eigentümer und Administratoren die Mitglieder ihres Mandanten. Neue Mitarbeiter werden über ihre geschäftliche E-Mail-Adresse eingeladen. Der Einladungslink gilt 72 Stunden, bestätigt die eingeladene Adresse und wird nach dem Öffnen aus der Browseradresszeile entfernt. Er darf nicht weitergegeben werden.

Neue Mitarbeiter vergeben ein eigenes Passwort mit mindestens zwölf Zeichen, richten einen Authenticator ein und bestätigen dessen sechsstelligen Code. Diese Einrichtung gilt 15 Minuten. Acht ungültige Codes sperren den Einrichtungsversuch. Nach erfolgreicher Einrichtung melden sie sich mit Passwort und Authenticator an. Eine zusätzliche Paketbuchung oder Zahlung des Mitarbeiters ist nicht erforderlich.

Bestehende Konten melden sich über den verlinkten neuen Tab an und bestätigen anschließend die Einladung. Ihr Passwort und Authenticator bleiben erhalten. Ein bereits aktives Konto eines anderen Mandanten kann die Einladung nicht annehmen. Bestehende Mitglieder werden über die Benutzerverwaltung verwaltet, nicht durch erneute Einladungen.

Die Aktivierung setzt einen aktiven, bezahlten Paket- oder Testzugang und einen weiterhin aktiven einladenden Eigentümer oder Administrator voraus. Die Benutzergrenze wird bei der Aktivierung geprüft: Pro 3, Business 10, Enterprise unbegrenzt. Eine versandte Einladung reserviert keinen Platz.

Eigentümer können Rollen anderer Mitglieder ändern und deren Mitgliedschaft sperren. Die eigene Eigentümerrolle bleibt dabei unverändert. Im Personalbereich können Mitarbeiter ausschließlich ihr eigenes Mitarbeiterportal öffnen; die Rolle Abrechnung erhält keinen Zugriff auf operative Module. Rollen- und Statusänderungen sowie erfolgreiche Einladungsaktivierungen werden protokolliert.

Betrieb: Migration 176 ergänzt mandantengebundene, verschlüsselte Einrichtungsdaten. Nach Aktivierung werden die vorläufige Passwortkopie und das MFA-Geheimnis daraus entfernt. Der Migrationsrollback verweigert das Entfernen einer befüllten Einrichtungstabelle, damit keine Kundennachweise verloren gehen. Bei einem Rollback nach echten Einladungen muss das kompatible Schema erhalten bleiben; kein automatisches Löschen oder Überschreiben von Kundenkonten.
