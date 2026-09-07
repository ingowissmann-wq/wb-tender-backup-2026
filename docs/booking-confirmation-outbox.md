# Buchungsbestätigung per E-Mail

Eine bestätigte Zahlung legt innerhalb derselben Datenbanktransaktion wie die Aktivierung genau einen Versandauftrag je Buchung an. Unbezahlte Vorgänge erzeugen keinen Auftrag. Wiederholte Zahlungsereignisse erzeugen keinen zusätzlichen Auftrag.

Der API-Prozess verarbeitet die persistente Warteschlange über zeitlich begrenzte Claims. SMTP-Fehler führen zu verzögerten Wiederholungen; nach zehn fehlgeschlagenen Versuchen ist der Auftrag FAILED. Betriebsüberwachung muss FAILED-Aufträge und überfällige PENDING-/SENDING-Aufträge alarmieren. Protokolle enthalten feste Fehlercodes ohne Empfänger oder SMTP-Geheimnisse.

Nach einem Prozessabbruch wird ein abgelaufener Claim erneut übernommen. SMTP bietet keine transaktionale Bestätigung gemeinsam mit PostgreSQL: Ein Absturz nach SMTP-Annahme und vor Datenbankbestätigung kann eine erneute E-Mail auslösen. Eine stabile Message-ID unterstützt die Erkennung solcher Wiederholungen; eine garantiert einmalige Zustellung wird nicht behauptet. Zahlungsaktivierung und Buchungsdatensatz bleiben idempotent.

Der Versand gilt als vom SMTP-Server angenommen, nicht als beim Empfänger gelesen. Der isolierte Browsernachweis verwendet einen simulierten SMTP-Transport und ersetzt keinen produktiven Zustellnachweis.

Die Regression prüft außerdem PostgreSQL-Funktionen mit zusammengesetztem Rückgabewert: `SELECT * FROM function(...)` ruft die zustandsverändernde Funktion einmal auf. `SELECT (function(...)).*` kann sie pro Ergebnisspalte wiederholen und ist für Job-Claims unzulässig.
