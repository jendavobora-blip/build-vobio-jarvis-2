# VOBIO JARVIS — první etapa návrhu

## Stav návrhu

V této větvi je připraven interaktivní, česky lokalizovaný prototyp devíti obrazovek: Velín, Agenti, Orchestrace, Projekty, Automatizace, Hlas, Paměť, Analytika a Nastavení. Navigace je vodorovně posuvná na mobilu; katalog obsahuje 20 lokálních ukázkových projektů. Stávající agentní plátno, hlasové ovládání, paměť a nastavení zůstávají zachované.

HUD nyní používá Three.js/WebGL pro prostorové jádro a síť původních sedmi agentů. Spojnice odrážejí události aktuálního běhu; simulace zůstává označena DEMO. 2D karty agentů zůstávají přístupné, jádro má SVG fallback. Při omezení pohybu, nedostupném WebGL nebo dlouhodobě nízkém výkonu se používá 2D režim. FPS se zobrazuje jako průběžný průměr, ale 60 FPS nebylo na iPhonu změřeno ani zaručeno.

## Bezpečnost a aktivace

- Živá volání API jsou na Vercel Preview vždy blokována; jinde vyžadují `JARVIS_LIVE_ENABLED=true`. V repozitáři ani workflow se tato proměnná nenastavuje.
- `DEEPSEEK_API_KEY` zůstává serverovým GitHub Secret a jeho hodnota se do kódu ani výstupů nekopíruje.
- Přihlašovací cookie nyní používá `SameSite=Lax`.
- Povolovací seznam build skriptů pnpm připouští pouze ověřený `esbuild@0.28.2`; `strictDepBuilds` zůstává aktivní.
- Manuální DeepSeek workflow nepřetrvává přihlašovací údaje checkoutu a odmítne změny workflow souborů.
- Automatizace jsou pouze lokální přepínače prototypu. Nespouštějí plánované úlohy ani externí akce.

Design je připraven ke schválení. Povolení živého backendu a produkční nasazení zůstávají samostatnými kroky po schválení.

## Ověření

Automatické testy pokrývají výchozí zákaz živého backendu, katalog projektů, filtrování a počet vizualizovaných agentů. Před sloučením spusťte `pnpm test`, `pnpm typecheck` a `pnpm build`.
