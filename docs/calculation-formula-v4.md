# Kalkulationsformel WB_COST_CATALOG_V4

Die produktive Engine ist `calculateSectorTender`. Der frühere generische Rechner ist deaktiviert: Er erlaubte quellenlose Werte und pauschale Ersatzwerte. Seine Werkzeugroute liefert einen ausdrücklichen Konfliktstatus und verweist auf den gesellschafts- und losbezogenen Workflow.

Die Engine übernimmt C01–C21 entsprechend `parameterUnitRules`, einschließlich der Einheit, Quelle, Parameterrevision und Gültigkeit. C05 ist die Urlaubsreserve, C06 die Krankheitsreserve und C07 die Ausfallreserve; keiner dieser Parameter ist ein FTE-Stundenteiler. C09/C10 sind Objekt-/Einsatzleitung, C13/C14 Fahrzeug-/Fahrtkosten, C15 Personalbeschaffung, C16 Nachunternehmer und C17 Versicherungen.

Kostenformeln:

- Grundlohn: belegte Produktivstunden × C01.
- Zuschläge: belegte Stunden je Zuschlagsart × C01 × freigegebener Prozentsatz aus C03.
- Arbeitgebernebenkosten: Grundlohn einschließlich Zuschlägen × C04.
- Urlaubs-, Krankheits- und Ausfallreserve: Grundlohn × C05/C06/C07.
- Stunden-, Monats- und Jahresansätze verwenden die belegten Stunden beziehungsweise die dokumentierte Vertragsdauer. Mengenbasierte Ansätze benötigen eine ausdrücklich belegte Menge pro Parameter. Ein freigegebener Nullansatz bleibt null; eine fehlende Angabe ist kein Nullansatz.
- Direkte Kosten umfassen Personal einschließlich Reserven, Material, Geräte, Fahrzeuge, Fahrtkosten, Nachunternehmer und gegebenenfalls Sicherheitsausstattung.
- Zurechenbare Kosten ergänzen Objekt-/Einsatzleitung, Personalbeschaffung und Versicherungen.
- Gesamtkosten ergänzen Verwaltung und den freigegebenen Risikozuschlag.

DB1 = Preis minus direkte Kosten. DB2 = Preis minus zurechenbare Kosten. DB3 = Preis minus Gesamtkosten. Der Zielpreis erfüllt alle drei freigegebenen Mindestziele C19/C20/C21: Bei Prozentzielen gilt Kostenbasis / (1 − Ziel/100), bei EUR-Zielen Kostenbasis + Ziel. Der höchste notwendige Preis wird auf volle Cent aufgerundet. Prozentziele ab 100 werden abgewiesen, nicht gekappt. Einzelkosten werden kaufmännisch auf Cent gerundet.

Ergebnisse enthalten Formelversion, Inputhash und Ergebnishash. Die Engine verwendet keine aktuelle Uhrzeit als versteckten Eingang; das Gültigkeitsdatum ist ausdrücklich erforderlich. Alte Ergebnisse bleiben eigenständige Revisionen. Verpflichtende Felder eines Preisblatts werden mit Zelladresse und Quelle validiert; ein unbelegtes oder leeres C23 kann kein erfolgreiches Ergebnis erzeugen.

Die Referenztests decken Reinigung, Sicherheit und Facility Management, verschiedene Kosteneinheiten, fehlende Pflichtwerte und geänderte Profilrevisionen ab. Dies ist ein Engine-Nachweis. Die Übernahme sämtlicher Mengen, Zuschlagsstunden und Pflichtzellen aus realen Unterlagen in den Kundenworkflow benötigt weiterhin eine gesonderte End-to-End-Abnahme.

## Quellenbindung und Tabellenpflichtfelder

Die Vorbewertung berechnet keinen eigenen Preis mehr. Sie kann lediglich `BEREIT_FUER_KALKULATIONSENGINE` melden; Geldwerte entstehen ausschließlich im versionierten Schritt mit `calculateSectorTender`.

Der Kalkulationsschritt verwendet Dokumente des exakt gebundenen Loses sowie explizit als `TENDER_GLOBAL` gekennzeichnete gemeinsame Dokumente ohne widersprüchliche Losbindung. Dateinamen allein begründen keine gemeinsame Gültigkeit. Profil-Snapshots werden zusätzlich auf Gesellschaft und Leistungsart begrenzt. Ohne verifizierte Dokumente darf kein vollständiger Kalkulationserfolg entstehen.

Excel-Spalten folgen ihren tatsächlichen Zelladressen, auch wenn vorherige Zellen fehlen. Leere XML-Zellen bleiben erhalten. Explizite Datenvalidierungen mit `allowBlank=false` werden quellengebunden geprüft: numerische Grenzen, Ganzzahlen, Textlängen und wörtliche Wertelisten. Unbekannte Formeln, Verweise oder übergroße Bereiche erfordern Prüfung und blockieren das Ergebnis. Ein Zellname wie C23 hat ohne Arbeitsmappe, Blatt und Regel keine universelle fachliche Bedeutung. Die Prüfungen sowie Dokument-Hashes und Losbindungen fließen in den Input-Snapshot ein. Arbeitsmappen ohne explizite Validierungsregeln benötigen weiterhin eine fachlich belegte Dokumentvorlage; das Fehlen von Excel-Regeln beweist keine Vollständigkeit der Bietereingaben.
