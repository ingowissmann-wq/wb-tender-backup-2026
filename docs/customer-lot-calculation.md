# Dokumentgebundene Loskalkulation

Eine aktuelle automatisch oder ausdrücklich bestätigte Loszuordnung kann unter **Los kalkulieren** berechnet werden. Eigentümer und Administratoren verwenden dabei genau die gespeicherte Version des zugeordneten Unternehmensprofils.

Die Quelldatei wird im eigenen Mandanten hochgeladen. Für Produktivstunden, Vertragsmonate und erforderliche Zuschlagsstunden oder Mengen sind Datei, Tabellenblatt, Zelle und Einheit festzulegen. Die Anwendung liest den Wert selbst; sie übernimmt keinen unabhängig eingegebenen Ersatzwert. Die fachliche Bedeutung und Loszugehörigkeit der ausgewählten Zellen müssen ausdrücklich bestätigt werden.

Nicht vorhandene Zellen, Text statt Zahl, negative Mengen, falsche Einheiten, Formeln ohne verifizierbare feste Quelle und verletzte Excel-Pflichtregeln blockieren die Berechnung. Eine Adresse wie C23 ist nur zusammen mit ihrem Blatt, Dokument und fachlichen Zweck eindeutig.

Die vorhandene Kalkulationsengine berechnet Kosten, Stunden- und Monatspreis sowie DB1, DB2 und DB3. Jede Ausführung speichert Eingaben, Quellen, Dokumenthashes, Profilbezug und Ergebnis als neue Version. Identische Wiederholungen desselben Auftrags erzeugen keine Doppelberechnung. Ein wiederholt bearbeiteter Ausschreibungsbereich belegt nur einen Platz im jeweiligen Monatskontingent.

Verwendete Quelldateien können nicht gelöscht werden, solange eine historische Kalkulation darauf verweist. Eine fehlgeschlagene Berechnung wird als blockiert gespeichert. Geänderte Ausschreibungsquellen oder ungeklärte Zuordnungen verlangen vorab eine erneute Prüfung.

Dieser Schritt ist keine automatische fachliche Ermittlung sämtlicher Mengen aus beliebigen Vergabeunterlagen und keine Managementfreigabe oder externe Abgabe. PDF-/Formularaufbereitung, vollständige Angebotsprüfung und Angebotspaket benötigen ihre eigene verbundene Abnahme.
