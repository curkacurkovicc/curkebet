# ćurkebet 🦃

Prediction market za ekipu: nalozi sa korisničkim imenom i šifrom, 🪙 1.000 na početku i +100 svaki dan,
pitanja DA/NE, opklade, rang lista. Ko postavi pitanje, mora i da ga reši.

## Postavljanje (besplatno, ~10 minuta, najlakše sa računara)

### 1. Baza — Neon (besplatan Postgres)
1. Otvori https://neon.tech i napravi nalog.
2. Napravi novi projekat (region: Frankfurt).
3. Kopiraj **connection string** (počinje sa `postgresql://...`). Trebaće ti u koraku 3.

### 2. Kod — GitHub
1. Na https://github.com napravi novi repozitorijum (npr. `curkebet`).
2. Klikni **Add file → Upload files** (ili „uploading an existing file” u praznom repozitorijumu)
   i izaberi sve fajlove: `server.js`, `package.json`, `package-lock.json`, `render.yaml`,
   `index.html`, `uputstvo.html`, `README.md`. Nema podfoldera.
3. Klikni **Commit changes**.

### 3. Hosting — Render
1. Otvori https://render.com i prijavi se preko GitHub-a.
2. **New → Blueprint**, izaberi svoj `curkebet` repozitorijum.
3. Kada te pita za promenljive:
   - `DATABASE_URL` → nalepi connection string iz Neon-a.
   - `INVITE_CODE` → izmisli kod (npr. `drugari2026`) ili ostavi prazno ako hoćeš da svako sa linkom može da se registruje.
4. Klikni **Apply**. Posle par minuta dobijaš adresu tipa `https://curkebet-xxxx.onrender.com`.

### 4. Pozovi drugare
Pošalji im link. Ako si postavio pozivni kod, pošalji link sa kodom da im se sam popuni:

```
https://curkebet-xxxx.onrender.com/?kod=drugari2026
```

## Dobro je znati
- Besplatan Render server „zaspi” posle 15 minuta bez posetilaca. Prvo otvaranje posle toga traje oko pola minuta, posle radi normalno.
- Početno stanje je 1.000 (promenljiva `START_BALANCE` to menja). Dnevni bonus kreće od sledećeg dana.
- Novi dan (i novi bonus) počinje u ponoć po beogradskom vremenu. Promenljiva `TIMEZONE` to menja.
- Šifre se čuvaju heširane (bcrypt). Zaboravljenu šifru ne može niko da vrati, ali može da se resetuje u bazi.
- Isplata: ceo bazen jednog pitanja deli se onima koji su pogodili, srazmerno ulogu. Ako niko nije pogodio ili je pitanje poništeno, ulozi se vraćaju.

Igračima je uputstvo dostupno na adresi `/uputstvo` (link je i na ekranu za prijavu).

## Lokalno pokretanje
```
npm install
DATABASE_URL=postgres://korisnik:sifra@localhost:5432/curkebet npm start
```
Otvori http://localhost:3000
