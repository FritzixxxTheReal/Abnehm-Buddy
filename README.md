# Abnehm-Buddy

Gewicht (morgens/abends), Kalorien und Fotos eintragen. Eine KI (Google Gemini, kostenloser Tarif) antwortet im Stil von Personen, die du anlegst: Sie lobt bei Abnahme, motiviert bei Stagnation und schimpft bei Zunahme. Morgens und abends kommt eine Erinnerung per Mail.

## 1. Auf GitHub Pages veröffentlichen

1. Neues Repository auf GitHub anlegen (z. B. `abnehm-buddy`).
2. Alle Dateien aus diesem Ordner hochladen, **inklusive** `.github/workflows/reminder.yml`.
3. Im Repo: **Settings → Pages → Source: „Deploy from a branch“**, Branch `main`, Ordner `/ (root)` → Save.
4. Nach ca. 1 Minute ist die Seite unter `https://<dein-name>.github.io/abnehm-buddy/` erreichbar.

> Deine Daten (Gewichte, Fotos, Personen, API-Key) liegen **nur in deinem Browser**, nicht im Repo. Auch wenn das Repo öffentlich ist, sieht niemand deine Werte. Nutz immer denselben Browser oder lade das Backup (Einstellungen → Daten) auf dem anderen Gerät.

## 2. KI einrichten

1. Mit deinem privaten Google-Konto auf <https://aistudio.google.com/apikey> einen kostenlosen API-Key erstellen. Keine Zahlungsdaten hinterlegen, dann bleibt es sicher kostenlos.
2. Auf der Seite unter **Einstellungen** den Key eintragen und speichern.
3. Unter **Personen** mindestens eine Person anlegen (Name, Alter, Beziehung, wie sie redet).

Hinweise:
- Im Gratis-Tarif darf Google Eingaben (auch Fotos) zur Verbesserung seiner Modelle verwenden.
- Die Sicherheitsfilter für harsche Sprache sind so weit wie möglich abgeschaltet. Nacktfotos blockiert Google trotzdem; Unterwäsche oder Sportkleidung gehen.
- Kommt „Modell nicht gefunden“, in den Einstellungen ein anderes Modell wählen. Google benennt Modelle öfter um.

## 3. E-Mail-Erinnerungen einrichten

Die Mails verschickt GitHub Actions über ein Mailkonto, das du angibst (z. B. ein Gmail-Konto mit App-Passwort).

Im Repo: **Settings → Secrets and variables → Actions**

**Secrets** (Tab „Secrets“ → „New repository secret“):

| Name | Beispiel |
|---|---|
| `MAIL_TO` | die Adresse, an die die Erinnerung geht |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | das Absenderkonto, z. B. `meinbuddy@gmail.com` |
| `SMTP_PASS` | App-Passwort des Absenderkontos |

Bei Gmail: Zwei-Faktor-Anmeldung aktivieren, dann unter <https://myaccount.google.com/apppasswords> ein App-Passwort erzeugen.

**Variables** (Tab „Variables“, optional):

| Name | Beispiel |
|---|---|
| `SITE_URL` | `https://<dein-name>.github.io/abnehm-buddy/` (Link in der Mail) |
| `BUDDY_NAMES` | `Lisa, Tom` (wer als Absender im Betreff steht) |

Testen: **Actions → „Erinnerung per Mail“ → Run workflow**.

Zeiten: 7:00 und 20:00 Uhr im Winter, 8:00 und 21:00 Uhr im Sommer (GitHub rechnet in UTC und startet oft ein paar Minuten später). Ändern kannst du das in `.github/workflows/reminder.yml`.

Hinweis: GitHub pausiert zeitgesteuerte Workflows, wenn im Repo 60 Tage lang nichts passiert. Dann im Actions-Tab wieder aktivieren.

## So bewertet die Seite

- **Trend:** Durchschnitt der Morgengewichte der letzten 3 Tage verglichen mit dem Durchschnitt von vor ca. zwei Wochen (Tag −17 bis −11). Ab −0,3 kg gilt es als Abnahme, ab +0,3 kg als Zunahme, dazwischen als Stagnation. Abendgewichte zählen nicht, weil Essen und Wasser sie verfälschen.
- **Defizit:** Grundbedarf + Sport − Gegessen. Ab 700 kcal „gut“, ab 1000 kcal „super“. Den Grundbedarf berechnet die Seite aus Geschlecht, Alter, Größe und Gewicht, oder du trägst ihn selbst ein.
- **Fotos:** Wenn es ein Foto von heute und eins von vor ca. 14 Tagen (±5 Tage) gibt, bekommt die KI beide zum Vergleich.
