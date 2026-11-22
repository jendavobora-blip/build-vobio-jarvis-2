# VOBIO JARVIS — implementační stav a akceptace

Tento soubor zachycuje skutečný stav větve PR #1. **Aplikace není dokončena ani schválena k produkčnímu provozu.** Práce mimo aktivní relaci automaticky nepokračuje.

## Bezpečnostní brány

- [x] Živá AI volání jsou serverově vypnutá bez `JARVIS_LIVE_ENABLED=true`; Vercel Preview je vypíná i při nastavené hodnotě. Akceptace: test flagu a přímé POST `/api/chat` v Preview bez volání poskytovatele.
- [ ] Před aktivací živého režimu musí vlastník schválit design **a zabezpečení**; produkce a placené služby se schvalují samostatně.
- [~] Paměť je oddělena serverovou identitou relace a databázová migrace má vlastníka; pozvánky a plnohodnotné uživatelské účty zatím nejsou dokončené. Akceptace: owner-scoped dotazy a testy migrace.
- [~] API schvalování vytvoří neměnný plán s SHA-256 hash a stav pending/approved/denied/executed; kritická akce zatím není propojena na UI ani spouštěč externího nástroje. Akceptace: unit test neměnného hash a negativní test změněného plánu.
- [ ] Nahradit nejlepší možné limity po instancích a neatomické denní účtování centrální atomickou rezervací rozpočtu. Akceptace: paralelní požadavky nepřekročí sjednaný limit v několika instancích; chyby DB vedou k bezpečnému odmítnutí.
- [ ] Zavést důvěryhodné určení klienta, ochranu proti CSRF a distribuované omezení pokusů o přihlášení; prověřit proxy a původ požadavků. Akceptace: automatizované negativní testy ve více instancích.
- [ ] Před nasazením vývojových agentů nahradit současné manuální AI workflow izolovaným běhovým prostředím bez přístupu k neoprávněným repozitářům a secrets a s vynucenými pravidly mimo model. Akceptace: test pokusů o únik dat, úpravu pravidel a neautorizované akce.

## Obrazovky

- [~] JARVIS Core: text, české diktování a předčítání v podporovaných prohlížečích, skutečný WebGL základ a 2D fallback. Chybí hlasové příkazy, vypínatelné zvukové efekty a ověření iOS Shortcuts. Akceptace: uživatelské testy na iPhonu včetně zamítnutí mikrofonu a omezení pohybu.
- [~] Mission Control: stávající obrazovka Orchestrace zobrazuje stav a demo; není trvalá historie úloh. Akceptace: reálný průběh a obnovená historie po přihlášení.
- [~] Agent Hub: stávající Agenti mají interaktivní 3D síť a přístupné 2D karty původních rolí. Chybí nová sada rolí, oprávnění a nástroje. Akceptace: správa schopností vynucuje oprávnění i na serveru.
- [ ] Research Studio: zdroje, dokumenty a analýzy. Akceptace: prokazatelné citace a práce s oprávněnými dokumenty bez neohlášených externích přenosů.
- [ ] Development Studio: autorizovaný repozitář, izolované změny, testy a PR. Akceptace: auditovatelný průchod ve schváleném rozsahu bez přístupu k produkčním tajemstvím.
- [~] Projects: pouze ukázkové položky, nikoli uživatelské projekty. Akceptace: oddělený katalog skutečných technologií a import pouze oprávněných GitHub repozitářů.
- [ ] Approvals: bezpečné schvalování plánů a jejich verzí. Akceptace: změněný plán vyžaduje nové potvrzení, kritické akce samostatné potvrzení.
- [~] Memory: lokální a volitelná databázová paměť, import/export, hledání v názvu a obsahu a šifrování citlivého obsahu. Chybí izolace uživatelů a bezpečná migrace. Akceptace: testy izolace, obnovy, exportu a mazání.
- [~] Settings: stávající nastavení připojení, agentů, rozpočtu a hlasu; chybí účty a správa integrací. Akceptace: serverově vynucená práva a bezpečné relace.
- [~] Funkce první etapy (hlas, rutiny a analytika) jsou stále dostupné v samostatných obrazovkách; při přechodu na cílovou navigaci se nesmí ztratit.

## 3D a výkon

- [~] Three.js vykresluje jádro a síť sedmi stávajících agentů. Stav agentů mění velikost bodu, klepnutí otevře detail, paralelní 2D karty zůstávají dostupné klávesnicí. Nejde o nové agentní role.
- [~] Vykreslování měří průměr FPS v pětisekundových oknech, snižuje pixel ratio a při dlouhodobě nízkém výkonu přechází na 2D; při omezení pohybu používá 2D. Akceptace: ověřit fallback, ztrátu WebGL kontextu, uvolnění zdrojů a skutečné FPS na konkrétních iPhonech; **60 FPS nebylo na iPhonu naměřeno**.
- [~] Spojnice 3D sítě odpovídají událostem aktuálního běhu; v DEMO režimu jde o simulaci. Akceptace: automatizovaně ověřit vykreslené vazby podle událostí.

## Agenti, DeepSeek a vývoj

- [~] Stávající server podporuje strukturované výstupy, SSE události a přerušení; modelové odpovědi nejsou tokenově streamované. Stávající role nejsou cílových Router, Researcher, Architect, Coder, Analyst, Critic a Final Judge.
- [ ] Navrhnout a otestovat kompatibilní migraci rolí a pipeline Router → paralelní specialisté → Critic → Final Judge, skutečný tool calling, audit a pevné rozpočty. Akceptace: integrační testy s mockovaným poskytovatelem, přerušením a chybami; živý test pouze po schválení.
- [ ] Bezpečně implementovat osm vývojových rolí a posoudit Aider, OpenCode a OpenHands bez automatické instalace nebo aktivace. Akceptace: každá změna probíhá ve schválené izolované větvi s testy, PR a kontrolou oprávnění.
- [ ] Ověřit oficiální aktuální API modely a ceník před použitím; bezpečně nakonfigurovat serverový klíč zvlášť pro Vercel. Akceptace: žádný klíč v klientovi ani logu, testy retry, tool calling, streamu a účtování.

## Katalog a projekty

- [ ] Ověřit oficiální repozitáře, licence, oprávnění, způsoby integrace a náklady všech 20 požadovaných technologií. Rozlišit katalog, připravený adaptér a aktivní integraci; skutečné projekty importovat odděleně. Akceptace: každá položka má zdroj, datum ověření a přesný stav; integrace nejsou aktivovány bez souhlasu.
- Požadovaný seznam k ověření: Mastra, LangGraph.js, CrewAI; Codex, OpenCode, OpenHands, Cline, Vercel Coding Agent Template; Stagehand, Browser Use, Skyvern, Firecrawl, Open Deep Research; bolt.diy, Dyad, Playwright MCP; n8n, Mem0, MCP Servers a Langfuse. Je nutné rozlišit skutečné open-source licence od jiných licencí a neověřené údaje nepovažovat za hotové.

## Účty, paměť a schvalování

- [ ] Navrhnout vlastníka a pozvánky, autentizaci, oddělení dat po uživatelích, šifrování, historii a nedestruktivní migrace. Současný přístupový kód neposkytuje uživatelskou izolaci. Akceptace: testy izolace tenantů, expirovaných relací, změny klíče, exportu, mazání a obnovení zálohy.
- [ ] Implementovat autonomii C jako serverem vynucený auditovaný stavový automat se svázáním souhlasu s neměnným plánem. Akceptace: žádná externí akce bez správného souhlasu, opakované přehrání a změna plánu jsou odmítnuty.

## Testování a pokračování

- [~] `pnpm test`, `pnpm typecheck`, `pnpm build`, zamčená instalace a `pnpm test:e2e` jsou k dispozici. E2E pokrývá ochranu Preview, demo, paměť, omezení pohybu a WebGL fallback v emulaci. Ještě chybí lint, širší E2E, skutečné iPhone testy, integrační a bezpečnostní testy, měření spotřeby a FPS na iPhonu.
- [x] Copilot Code Review: workflow guard detekuje staged i unstaged `.github/workflows` změny; výsledek běhu je viditelný v obrazovce Tok; nepodporovaný hlasový vstup přejde na fokusovaný textový kompozitor. Akceptace: unit test workflow guardu a 2 Playwright scénáře.
- [ ] Po každé změně zkontrolovat skutečné Preview deploymenty i chování aplikace; stav „build passed“ sám nestačí.
- Pokračování: zkontrolovat aktuální stav PR #1 a pracovní strom; navázat bez přepsání dat. Nejdříve dokončit bezpečnostní hranice, účty a migrační strategii; všechny implementační fáze průběžně ověřovat. Neaktivovat AI, další placené služby ani produkci bez výslovného souhlasu.
