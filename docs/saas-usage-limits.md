# Serverseitige Ausschreibungskontingente

Migration 165 reserviert für Pro zehn und für Business 25 unterschiedliche Ausschreibungs-Arbeitsbereiche pro UTC-Kalendermonat. Enterprise hat keine numerische Grenze. Der bezahlte Kompletttest verwendet während seiner gültigen Laufzeit den Enterprise-Umfang.

Die Reservierung erfolgt beim Übergang eines Autopilot-Jobs nach RUNNING, auch wenn ein Aufrufer die Claim-Funktion umgeht. Ein direkter Übergang nach SUCCEEDED wird ebenfalls geprüft. Der Job muss `payload.workspaceId` mit einem existierenden Arbeitsbereich desselben Mandanten enthalten. Ohne gültigen Zugriff wird nicht reserviert. Ein Arbeitsbereich kann nicht auf eine andere Ausschreibung umgebunden werden.

Weitere Jobs und Wiederholungen für denselben Arbeitsbereich im selben Monat verbrauchen keinen zusätzlichen Platz. Eine fehlgeschlagene Bearbeitung gibt die Reservierung nicht frei. Ein neuer Bearbeitungsversuch im Folgemonat zählt dort; der bloße Abschluss eines bereits laufenden Jobs zählt nicht erneut. Die Reservierungen bleiben als Nachweis erhalten und sind für die API-Datenbankrollen nicht beschreibbar. Neue Monatsreservierungen verwenden eine Transaktionssperre pro Mandant, bevor gezählt und eingefügt wird.

Aktive Benutzer und Unternehmen werden ebenfalls unter einer mandantengebundenen Transaktionssperre gezählt. Fehlende Abonnements erlauben keine unbegrenzte Anlage. Die bestehenden Regeln begrenzen aktive Benutzer; Einladungen erhalten erst bei zulässiger Aktivierung Zugriff.

Regression: `tests/saas-usage-limits.integration.sql` prüft alle drei Tarife, Wiederholungen, abgelaufenen Zugriff, fremde Arbeitsbereiche und unveränderliche Zuordnung. `tests/saas-usage-concurrency.integration.sh` lässt zwei echte PostgreSQL-Transaktionen um den letzten Pro-Platz konkurrieren. Beide laufen ausschließlich innerhalb der isolierten Rollout-Abnahme, zusammen mit dem vollständigen Rückwärtsvergleich.

Dieser Mechanismus ersetzt weder einen funktionierenden Autopilot-Worker noch die fachliche Abnahme der Kalkulation und Angebotserstellung. Diese benötigen eigene Integrationsnachweise vor der Liveschaltung.
