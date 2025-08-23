# Høringsdata Henter

En web-applikation til at hente høringssvar fra Københavns Kommunes "Bliv Hørt" platform.

## Funktioner

- **Enkel brugergrænseflade**: Indtast kun et hørings-ID for at hente data
- **Automatisk datahentning**: Henter høringsoplysninger og svar automatisk
- **Paginering**: Henter automatisk alle sider med høringssvar
- **Cookie-mur bypass**: Automatisk håndtering af cookie-consent systemer
- **PDF-konvertering**: Konverterer automatisk PDF-bilag til læsbar tekst
- **Bilag-håndtering**: Viser og linker til alle uploadede dokumenter
- **Responsivt design**: Fungerer på både desktop og mobile enheder
- **Moderne UI**: Pæn og brugervenlig grænseflade
- **Fejlhåndtering**: Informative fejlmeddelelser og loading states

## Installation

1. **Klon eller download projektet**
   ```bash
   git clone <repository-url>
   cd fetcher
   ```

2. **Installer dependencies**
   ```bash
   npm install
   ```

3. **Start serveren**
   ```bash
   npm start
   ```

   Eller for udvikling med auto-reload:
   ```bash
   npm run dev
   ```

4. **Åbn applikationen**
   Gå til `http://localhost:3010` i din browser

## Brug

1. **Søg**: Brug søgefeltet til at søge på titel eller ID
2. **Filtrér**: Vælg status (Alle/Aktive/Afsluttede) efter behov
3. **Hent svar**: Klik "Hent svar" ud for den høring du vil hente detaljer for
4. **Se resultaterne**: Høringsoplysninger, statistik og svar vises i tabellen

## Eksempel

For at hente data fra høring 206:
- Indtast `206` i input-feltet
- Klik "Hent Data"
- Se høringsoplysninger og alle tilgængelige svar

## Teknisk information

### Dependencies
- **Express.js**: Web server framework
- **Axios**: HTTP client til at hente data
- **Cheerio**: HTML parsing og DOM manipulation
- **CORS**: Cross-origin resource sharing
- **pdf-parse**: PDF tekst-ekstraktion og konvertering
- **Puppeteer**: Browser automation til at omgå cookie-mure

### API Endpoints
- `GET /api/hearing/:id` - Henter høringsdata for et specifikt ID

### Struktur
```
fetcher/
├── server.js          # Express server og API endpoints
├── package.json       # Projekt dependencies
├── public/
│   └── index.html     # Frontend grænseflade
└── README.md          # Denne fil
```

## Fejlfinding

### Almindelige problemer

1. **"Kunne ikke hente høringsdata"**
   - Tjek at hørings-ID'et er korrekt
   - Sørg for at du har internetforbindelse
   - Prøv et andet hørings-ID

2. **Server starter ikke**
   - Sørg for at Node.js er installeret
   - Kør `npm install` for at installere dependencies
   - Tjek at port 3010 ikke er i brug

3. **Ingen svar fundet**
   - Nogle høringer har måske ikke offentlige svar
   - Prøv et andet hørings-ID
   - Tjek den originale høringsside for at bekræfte

## Udvikling

### Tilføj nye funktioner
1. Rediger `server.js` for backend ændringer
2. Rediger `public/index.html` for frontend ændringer
3. Test ændringerne lokalt
4. Deploy til produktion

### Miljøvariabler
- `PORT`: Server port (standard: 3010)

### Deploy til Render
1. Push dette repo til GitHub
2. I Render: Opret ny Web Service
   - Root directory: `fetcher`
   - Build command: `npm ci && python3 -m pip install --user -r requirements.txt`
   - Start command: `bash -lc "mkdir -p data/uploads tmp && rm -rf uploads && ln -s data/uploads uploads && node server.js"`
   - Health check path: `/healthz`
3. Konfigurer miljøvariabler:
   - `NODE_ENV=production`
   - `OPENAI_API_KEY` (valgfri, for opsummering)
   - `MODEL_ID=gpt-5` (valgfri)
   - `SESSION_SECRET` (Generate) 
4. Tilføj disk (Persistent) `app-data` monteret på `/opt/render/project/src/fetcher/data`

#### OpenAI og generering
- `OPENAI_API_KEY`: Din OpenAI nøgle
- `MODEL_ID`: Modelnavn (standard: `gpt-5`)
- `OPENAI_VERBOSITY`: Styr hvor meget modellen skriver: `low` | `medium` | `high` (standard: `low`)
- `OPENAI_REASONING_EFFORT`: Hvor meget reasoning-indsats: `minimal/low` | `medium` | `high` (standard: `minimal` → behandles som `low`)
- `MAX_TOKENS`: Maks. output tokens for `gpt-5` (bruges som `max_output_tokens`)
- `SUMMARY_PARALLEL`: Kør flere varianter parallelt: `true` | `false` (standard: `true`)
- `INTERNAL_API_TIMEOUT_MS`: Timeout for interne HTTP-kald under opsummering (ms). Øg ved store høringer (standard: `300000`).

Eksempel på `.env` i mappen `fetcher/`:

```
OPENAI_API_KEY=sk-...
MODEL_ID=gpt-5
OPENAI_VERBOSITY=low
OPENAI_REASONING_EFFORT=minimal
MAX_TOKENS=16000
SUMMARY_PARALLEL=true
INTERNAL_API_TIMEOUT_MS=300000
```

## Licens

MIT License - se LICENSE fil for detaljer.

## Support

Hvis du oplever problemer eller har spørgsmål, opret venligst en issue i projektet.
