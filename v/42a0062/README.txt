Stoma-Schablonen Skalierer v2: Offline-Paket

Inhalt:
- index.html
- vendor/ (lokale Bibliotheken)
- start_stoma.command (Ein-Klick Start fuer macOS)
- start_stoma_windows.bat (Ein-Klick Start fuer Windows)
- start_stoma_windows.ps1 (lokaler Windows-Server ohne Python)

So verwendest du das Paket:
1. Den Ordner dist/offline_package komplett auf den Zielrechner kopieren.
2. Doppelklick:
	- macOS: start_stoma.command
	- Windows: start_stoma_windows.bat
3. Die App oeffnet sich unter: http://127.0.0.1:8765
4. Vorlage laden, Linie pruefen, Ausgabe herunterladen oder drucken.

Hinweise:
- Fuer PDF-Worker und Browser-Sicherheit bitte ueber den lokalen Server arbeiten, nicht direkt per file://.