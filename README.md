# Novapers back-up-ontvanger

Een kleine, zelfstandige applicatie die back-ups van novapers.nl ontvangt en
bewaart — bedoeld om op een TWEEDE server te draaien, zodat je back-ups niet
alleen op de hoofdserver staan.

Deze versie is zo opgezet dat de tweede server **nooit zelf hoeft te
bouwen** — die haalt alleen een kant-en-klaar image op.

## Stap 1 — Het image bouwen (eenmalig, of automatisch bij wijzigingen)

### Optie A — Automatisch via GitHub (aanbevolen)

1. Maak een nieuwe, lege GitHub-repository aan (bijv.
   `novapers-backup-receiver`).
2. Zet de inhoud van deze map (inclusief de `.github/`-map) daarin en push:
   ```bash
   cd backup-receiver
   git init
   git add .
   git commit -m "Eerste versie"
   git branch -M main
   git remote add origin https://github.com/JOUW-GEBRUIKERSNAAM/novapers-backup-receiver.git
   git push -u origin main
   ```
3. GitHub bouwt nu automatisch het image (te zien bij het tabblad "Actions"
   in je repo) en zet het klaar op GitHub Container Registry. Dit gebeurt
   voortaan **automatisch** bij elke toekomstige wijziging die je pusht —
   je hoeft dan nooit meer zelf iets te bouwen.
4. Ga naar je GitHub-profiel → "Packages" → `novapers-backup-receiver` →
   "Package settings" → onderaan "Change visibility" → zet 'm op **Public**.
   (Dat is veilig: het image bevat geen wachtwoorden, die geef je pas apart
   mee bij het starten.)

### Optie B — Handmatig, eenmalig (als je geen nieuwe GitHub-repo wilt)

Bouw het image op je HOOFDSERVER (die kan dat wel aan) en push het zelf:
```bash
cd backup-receiver
docker build -t ghcr.io/JOUW-GEBRUIKERSNAAM/novapers-backup-receiver:latest .

# Eenmalig inloggen bij GHCR — maak eerst een Personal Access Token aan op
# github.com/settings/tokens met alleen het vinkje "write:packages"
echo "JOUW_TOKEN" | docker login ghcr.io -u JOUW-GEBRUIKERSNAAM --password-stdin

docker push ghcr.io/JOUW-GEBRUIKERSNAAM/novapers-backup-receiver:latest
```
Maak het package hierna ook Public via GitHub → Packages (zie stap 4 hierboven).

## Stap 2 — Installatie op de tweede VPS (alleen ophalen, niet bouwen)

1. Kopieer alleen dit bestand naar de tweede VPS (de rest is niet nodig
   daar): `docker-compose.yml`. Je gebruikersnaam (`iitssjstn`) staat er al
   in ingevuld.

2. Maak een `.env`-bestand aan met een sterk, willekeurig wachtwoord:
   ```bash
   echo "BACKUP_SHARED_SECRET=$(openssl rand -hex 32)" > .env
   cat .env
   ```
   Onthoud/bewaar de waarde die hier verschijnt.

3. Haal het image op en start — dit is een download, geen build:
   ```bash
   docker compose pull
   docker compose up -d
   ```

4. **Belangrijk — beveilig de verbinding.** Poort 4000 staat nu open op
   deze server, zonder HTTPS. Zet hier een reverse proxy (bijv. Nginx Proxy
   Manager, net als bij de hoofdsite) vóór, met een eigen (sub)domein en een
   Let's Encrypt-certificaat — anders reist het gedeelde wachtwoord
   onversleuteld over het internet. Wijs dat domein naar poort 4000 op deze
   server.

5. Test of het werkt:
   ```bash
   curl -H "Authorization: Bearer JOUW_SHARED_SECRET" https://back-up.jouwdomein.nl/backups
   ```
   Dit hoort `{"backups":[]}` terug te geven (nog leeg, dat is prima).

## Bij de hoofdsite instellen

Ga naar **Instellingen → Back-ups** op novapers.nl, en vul daar de URL van
deze ontvanger (bijv. `https://back-up.jouwdomein.nl`) en het gedeelde
wachtwoord van stap 2 hierboven in. Vanaf dat moment stuurt de hoofdsite
automatisch een kopie van elke nieuwe back-up hierheen.

## Bewaartermijn aanpassen

Standaard bewaart deze ontvanger back-ups **14 dagen**, onafhankelijk van
wat op de hoofdsite is ingesteld. Wil je dat aanpassen, wijzig dan
`RETENTION_DAYS` in `docker-compose.yml` op de tweede VPS en herstart:
```bash
docker compose up -d
```

## Een nieuwe versie ophalen (na een update)

```bash
docker compose pull
docker compose up -d
```
Ook dit is alleen downloaden, nooit bouwen.
