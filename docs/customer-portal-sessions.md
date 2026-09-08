# Portalzugänge und gespeicherte Sitzungen

Wählen Sie unter **Portalzugänge** die eigene Gesellschaft und das passende Vergabeportal. Benutzername und Passwort werden verschlüsselt gespeichert und anschließend intern zurückgelesen. Die Anzeige enthält nur Bezeichnung, Portal und Versionsnummer.

**Anmeldung prüfen** verwendet ausschließlich das im Portalregister hinterlegte HTTPS-Anmeldeziel. Die gespeicherten Daten werden nur in ein überprüfbares POST-Anmeldeformular auf freigegebenen Authentifizierungshosts eingegeben. Unbekannte Formulare und zusätzliche MFA-Schritte bleiben als Prüfbedarf stehen; eine erfolgreiche Speicherung allein bestätigt keine Anmeldung.

Nach erfolgreicher Anmeldung wird die Sitzung in einem neuen Browserkontext wiederhergestellt und geprüft. Erst danach speichert WB-Tender sie verschlüsselt mit einer begrenzten Laufzeit. **Gespeicherte Sitzung prüfen** kontrolliert die erneut geladene Sitzung. Browsercookies und Sitzungstoken werden niemals in der Oberfläche oder API-Antwort ausgegeben.

Eine Änderung oder Schlüsselrotation des Zugangs macht frühere Sitzungen unbrauchbar. Fehlgeschlagene Wiederherstellungen sperren die betreffende Sitzung dauerhaft; starten Sie anschließend eine neue Anmeldung. Die Bindung an Mandant, Gesellschaft, Portal und Zugang lässt sich nicht ändern.

Die Anmelde- und Sitzungsprüfung führt keine Angebotsübermittlung aus. Ein konkreter Portaladapter benötigt weiterhin eine reale Abnahme seiner Dokumenten- und Losfunktionen, bevor eine weitergehende Nutzung als geprüft gelten kann.
