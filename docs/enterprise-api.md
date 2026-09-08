# Enterprise-Lese-API, Version 1

Die versionierte API ist für Eigentümer und Administratoren mit Enterprise- oder aktivem Kompletttest-Zugang unter `/saas/app/connect` zugänglich. Pro, Business, gesperrte Zugänge und reine Abrechnungsrollen werden serverseitig abgewiesen. Die API verwendet die bestehende native Sitzung nach Passwort- und TOTP-Anmeldung. Es gibt keine unbefristeten API-Schlüssel und keine Umgehung von MFA.

Verfügbare GET-Endpunkte:

- `/api/enterprise/v1/companies`: eigene Gesellschaften und Status.
- `/api/enterprise/v1/lot-assignments`: gespeicherte Loszuordnungen mit Quell-, Profil- und Versionsbindung.
- `/api/enterprise/v1/calculations`: gespeicherte Kalkulationsversionen und berechnete Ergebnisse.
- `/api/enterprise/v1/offer-packages`: eigene Angebotspaketversionen mit Kalkulations-, Dokumentprüfungs- und Manifestbindung.

`limit` liegt zwischen 1 und 100 und ist standardmäßig 50. Wenn `nextCursor` gesetzt ist, wird dessen Wert für die nächste Seite als `cursor` übergeben. Die Reihenfolge ist nach UUID stabil; neu angelegte Datensätze während einer Abfrage können einen neuen vollständigen Abruf erfordern. Dies ist keine inkrementelle Änderungs- oder Löschschnittstelle.

Der Mandant wird ausschließlich aus der authentifizierten Sitzung bestimmt. Ein mitgesendeter Mandant in URL oder Header ändert ihn nicht. Die Antwort enthält `apiVersion`, `tenantId`, `resource`, `items`, `nextCursor`, `readOnly` und `currentReadinessAssessed:false`. Historische Datensätze sind kein Nachweis einer aktuellen Management- oder Abgabefreigabe. Die Antwort enthält weder Portalpasswörter noch MFA-Geheimnisse oder Speicherpfade. Jeder erfolgreiche Abruf wird im eigenen Mandantenaudit protokolliert.

Beispiel aus einer bereits angemeldeten Sitzung: `GET /api/enterprise/v1/calculations?limit=50`. Es werden keine Geschäftsdaten verändert und keine Angebote übertragen. Aktuelle Managementfreigaben und Paketdownloads bleiben in den dafür vorgesehenen, gesondert geprüften Portalrouten.

Individuelle Anbindungen und SSO benötigen eine reale, eingerichtete und validierte Gegenstelle. Die Lese-API stellt keine solche Verbindung her und behauptet keine konfigurierte OIDC-Identität. Der produktive Abschluss dieser Anbindungen bleibt ein eigener Nachweis.
