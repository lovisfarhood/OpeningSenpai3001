# Interactive ChessBook

Installierbare, browserbasierte PWA für persönliche Schacheröffnungskurse.

## Datenschutz und Kursinhalte

Die öffentliche App enthält **keine Chessly-Kurse oder andere Repertoiredaten**.
Nutzer wählen auf ihrem eigenen Gerät einen Chessly-Kursordner oder eine ZIP-Datei aus. Die App prüft und verarbeitet den Kurs vollständig im Browser und speichert ihn in IndexedDB. Es findet kein Upload zum Webserver statt.

Dadurch werden nur die persönlich benötigten Kurse gespeichert. Auf einem neuen Gerät müssen die gewünschten Kurse erneut importiert werden.

Für den Practice-Modus enthält die öffentliche App zusätzlich **sanitisierte Lichess-Popularitätsstatistiken**. Sie enthalten nur Spielzahlen mit opaken Positions-/Kanten-IDs, aber keine FENs, Züge, Kommentare oder Kurslinien. Die Importance-Auswahl wird erst lokal berechnet, nachdem der Nutzer den passenden Kurs auf seinem Gerät importiert hat.

## Lokale Entwicklung

```bash
npm ci
npm run dev
```

## Prüfungen

```bash
npm run check
```

Der Produktions-Build enthält einen zusätzlichen Schutztest. Er bricht ab, falls ein `data/`-Ordner, bekannte Kursdatenpfade oder Chessly-Kurs-URLs im fertigen `dist/` auftauchen. Zusätzlich prüft er, dass öffentliche Popularitätsdateien keine Repertoirepositionen oder vorgefertigten Importance-Pfade enthalten.

## GitHub Pages

Der Workflow unter `.github/workflows/deploy-pages.yml` baut und prüft die PWA bei Änderungen auf `main`. Für ein Projekt-Repository wird automatisch der Vite-Basispfad `/<repository-name>/` verwendet. In den GitHub-Einstellungen muss Pages als Quelle **GitHub Actions** verwenden.
