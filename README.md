Abnehm-Buddy
Gewicht (morgens/abends), Kalorien und Fotos eintragen. Eine KI (Google Gemini, kostenloser Tarif) antwortet im Stil von Personen, die du anlegst: Sie lobt bei Abnahme, motiviert bei Stagnation und schimpft bei Zunahme. Morgens und abends kommt eine Erinnerung per Mail.

1. Auf GitHub Pages veröffentlichen
Neues Repository auf GitHub anlegen (z. B. abnehm-buddy).
Alle Dateien aus diesem Ordner hochladen, inklusive .github/workflows/reminder.yml.
Im Repo: Settings → Pages → Source: „Deploy from a branch“, Branch main, Ordner / (root) → Save.
Nach ca. 1 Minute ist die Seite unter https://<dein-name>.github.io/abnehm-buddy/ erreichbar.
Deine Daten (Gewichte, Fotos, Personen, API-Key) liegen nicht in diesem öffentlichen Repo. Sie liegen in deinem Browser und, wenn du die Synchronisation einrichtest (Schritt 3), zusätzlich in einem privaten Repo, das nur du sehen kannst.

2. KI einrichten
Mit deinem privaten Google-Konto auf https://aistudio.google.com/apikey einen kostenlosen API-Key erstellen. Keine Zahlungsdaten hinterlegen, dann bleibt es sicher kostenlos.
Auf der Seite unter Einstellungen den Key eintragen und speichern.
Unter Personen mindestens eine Person anlegen (Name, Alter, Beziehung, wie sie redet).
Hinweise:

Im Gratis-Tarif darf Google Eingaben (auch Fotos) zur Verbesserung seiner Modelle verwenden.
Die Sicherheitsfilter für harsche Sprache sind so weit wie möglich abgeschaltet. Nacktfotos blockiert Google trotzdem; Unterwäsche oder Sportkleidung gehen.
Kommt „Modell nicht gefunden“, in den Einstellungen ein anderes Modell wählen. Google benennt Modelle öfter um.
3. Handy und PC synchronisieren
Deine Daten werden in einem zweiten, privaten Repo gespeichert. Jedes Gerät bekommt einmal einen Schlüssel, danach läuft alles automatisch.

Daten-Repo anlegen

Auf GitHub ein neues Repository anlegen: Name abnehm-buddy-daten, Sichtbarkeit Private, Add README auf On.
Schlüssel (Token) erstellen

GitHub → Profilbild oben rechts → Settings → ganz unten Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
Name: Abnehm-Buddy Sync. Expiration: den längsten Zeitraum wählen.
Repository access: „Only select repositories“ → nur abnehm-buddy-daten auswählen.
Permissions → Repository permissions → Contents: „Read and write“.
Generate token und den Schlüssel (github_pat_…) kopieren. GitHub zeigt ihn nur einmal an. Bewahr ihn z. B. in deinem Passwort-Manager auf, du brauchst ihn für jedes Gerät.
Auf jedem Gerät Seite öffnen → Einstellungen → Synchronisation → Schlüssel einfügen → Verbinden. Oben neben dem Titel steht dann „✓ Sync“.

Hinweise:

Abgeglichen wird beim Öffnen der Seite, nach jedem Speichern und wenn du zur Seite zurückwechselst. Wurde derselbe Tag auf zwei Geräten geändert, gewinnt die letzte Änderung.
Der Gemini-Key und der Schlüssel selbst werden nicht hochgeladen. Den Gemini-Key trägst du auf jedem Gerät selbst ein.
Der Schlüssel darf nur auf das Daten-Repo zugreifen, sonst auf nichts in deinem Konto. Läuft er ab, erstellst du einen neuen und trägst ihn neu ein.
4. E-Mail-Erinnerungen einrichten
Die Mails verschickt GitHub Actions über ein Mailkonto, das du angibst (z. B. ein Gmail-Konto mit App-Passwort).

Im Repo: Settings → Secrets and variables → Actions

Secrets (Tab „Secrets“ → „New repository secret“):

Name	Beispiel
MAIL_TO	die Adresse, an die die Erinnerung geht
SMTP_HOST	smtp.gmail.com
SMTP_PORT	465
SMTP_USER	das Absenderkonto, z. B. meinbuddy@gmail.com
SMTP_PASS	App-Passwort des Absenderkontos
Bei Gmail: Zwei-Faktor-Anmeldung aktivieren, dann unter https://myaccount.google.com/apppasswords ein App-Passwort erzeugen.

Variables (Tab „Variables“, optional):

Name	Beispiel
SITE_URL	https://<dein-name>.github.io/abnehm-buddy/ (Link in der Mail)
BUDDY_NAMES	Lisa, Tom (wer als Absender im Betreff steht)
Testen: Actions → „Erinnerung per Mail“ → Run workflow.

Zeiten: 7:00 und 20:00 Uhr im Winter, 8:00 und 21:00 Uhr im Sommer (GitHub rechnet in UTC und startet oft ein paar Minuten später). Ändern kannst du das in .github/workflows/reminder.yml.

Hinweis: GitHub pausiert zeitgesteuerte Workflows, wenn im Repo 60 Tage lang nichts passiert. Dann im Actions-Tab wieder aktivieren.

So bewertet die Seite
Trend: Durchschnitt der Morgengewichte der letzten 3 Tage verglichen mit dem Durchschnitt von vor ca. zwei Wochen (Tag −17 bis −11). Ab −0,3 kg gilt es als Abnahme, ab +0,3 kg als Zunahme, dazwischen als Stagnation. Abendgewichte zählen nicht, weil Essen und Wasser sie verfälschen.
Defizit: Grundbedarf + Sport − Gegessen. Ab 700 kcal „gut“, ab 1000 kcal „super“. Den Grundbedarf berechnet die Seite aus Geschlecht, Alter, Größe und Gewicht, oder du trägst ihn selbst ein.
Fotos: Wenn es ein Foto von heute und eins von vor ca. 14 Tagen (±5 Tage) gibt, bekommt die KI beide zum Vergleich.
