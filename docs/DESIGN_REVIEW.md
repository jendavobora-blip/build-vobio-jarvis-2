# VOBIO JARVIS — první etapa návrhu

## Stav návrhu

V této větvi je připraven interaktivní, česky lokalizovaný prototyp devíti obrazovek: Velín, Agenti, Orchestrace, Projekty, Automatizace, Hlas, Paměť, Analytika a Nastavení. Navigace je vodorovně posuvná na mobilu; katalog obsahuje 20 lokálních ukázkových projektů. Stávající agentní plátno, hlasové ovládání, paměť a nastavení zůstávají zachované.

HUD používá stávající CSS/SVG a transformace místo WebGL. Animace respektují `prefers-reduced-motion`; výkon 60 FPS je cílová optimalizace, nikoli naměřená garance na všech modelech iPhonu.

## Bezpečnost a aktivace

- Živá volání API jsou serverově blokována, dokud není `JARVIS_LIVE_ENABLED=true`; v repozitáři ani workflow se tato proměnná nenastavuje.
- `DEEPSEEK_API_KEY` zůstává serverovým GitHub Secret a jeho hodnota se do kódu ani výstupů nekopíruje.
- Přihlašovací cookie nyní používá `SameSite=Lax`.
- Manuální DeepSeek workflow nepřetrvává přihlašovací údaje checkoutu a odmítne změny workflow souborů.
- Automatizace jsou pouze lokální přepínače prototypu. Nespouštějí plánované úlohy ani externí akce.

Design je připraven ke schválení. Povolení živého backendu a produkční nasazení zůstávají samostatnými kroky po schválení.

## Ověření

Automatické testy pokrývají výchozí zákaz živého backendu, katalog projektů, filtrování a počet vizualizovaných agentů. Před sloučením spusťte `pnpm test`, `pnpm typecheck` a `pnpm build`.
