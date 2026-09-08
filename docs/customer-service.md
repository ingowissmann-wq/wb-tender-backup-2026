# Kundenservice

Business, Enterprise und der separate Kompletttest enthalten `/saas/app/csm`. Pro erhält serverseitig keinen Zugriff. Kunden, Notizen und Servicefälle bleiben im eigenen Mandanten.

Eine Servicekundenakte enthält eine ausdrücklich gesetzte Phase, Kundenstatus, Bewertung und optionale Termine für Wiedervorlage und Vertragsprüfung. Ohne Bewertung bleibt sie `UNASSESSED`. Diese Termine erzeugen keine Rechnung und keine Zahlung.

Notizen erfassen Gespräche, E-Mails, Besprechungen oder Prüfungen. Der Eintrag dokumentiert eine Tätigkeit; er versendet keine E-Mail. Servicefälle enthalten Beschreibung, Priorität und eine ausdrücklich eingetragene Fälligkeit bis Tagesende UTC. Offene überfällige Fälle werden markiert.

Neue Fälle beginnen offen. Nach Bearbeitung oder Wartezeit kann die Lösung mit Begründung bestätigt werden. Erst gelöste Fälle können geschlossen werden. Gelöste oder geschlossene Fälle lassen sich mit Begründung wieder in Bearbeitung nehmen. Jede Änderung benötigt eine aktuelle Datenbankrevision und ausdrückliche Bestätigung. Gleichzeitige Änderungen werden als Konflikt abgewiesen; identische wiederholte Anlageanfragen erzeugen kein Duplikat.

Kunden und Fälle können aktiven Mitgliedern desselben Mandanten zugewiesen werden. Fremde oder gesperrte Benutzer sind unzulässig. Bei einer nicht mehr aktiven Zuständigkeit ist eine neue Zuweisung erforderlich. Kundenakten mit Verlauf werden nicht über die generische Löschroute gelöscht; der Status bildet Pause oder Ende der Kundenbeziehung ab. Für weitere interne Aufgaben steht die separate Aufgaben- und Fristenverwaltung zur Verfügung.
