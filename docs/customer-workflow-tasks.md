# Aufgaben und Fristen

Unter `/saas/app/workflow` legen Eigentümer und Administratoren Aufgaben für eine eigene aktive Gesellschaft an. Eine Aufgabe kann zusätzlich an eine aktuelle Loszuordnung gebunden werden. Verantwortliche müssen aktive Mitglieder desselben Mandanten sein. Fristen werden ausdrücklich eingegeben und mit ihrer Quelle oder fachlichen Begründung gespeichert; fehlende Fristen werden nicht ergänzt.

Jede Aufgabe enthält mindestens einen Pflichtschritt. Ein Abschluss verlangt alle bestätigten Schritte. Blockierte Aufgaben müssen vor dem Abschluss wieder in Bearbeitung genommen werden. Jeder neue Stand benötigt eine Begründung und wird als eigene Version mit Audit gespeichert. Gleichzeitige Änderungen desselben alten Stands werden zurückgewiesen; wiederholte identische Anfragen erzeugen keine weitere Version. Historische Schritte, Gesellschaft und Losbindung werden nicht überschrieben. Für geänderte Prüfschritte ist eine neue Aufgabe anzulegen.

Die Übersicht markiert überfällige Aufgaben und geänderte Losquellen. Bei veralteter Losbindung ist ein Abschluss gesperrt; ein begründeter Abbruch bleibt möglich. Eine Wiederöffnung verlangt erneute Prüfung aller Schritte. Die Aufgabenhistorie steht direkt an jeder Aufgabe zur Verfügung.

Ein Aufgabenabschluss ist eine dokumentierte Benutzerentscheidung. Er führt weder eine Kalkulation aus noch erteilt er eine Angebotsfreigabe oder sendet ein Angebot. Diese Vorgänge bleiben an ihre eigenen geprüften Prozesse gebunden. Automatische E-Mail-Erinnerungen und allgemeine frei programmierbare Prozessketten sind durch diesen Aufgabenablauf nicht implementiert.
