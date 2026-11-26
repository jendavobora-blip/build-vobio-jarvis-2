# VOBIO JARVIS — implementační stav a akceptace

Tento soubor zachycuje skutečný stav větve PR #1. **Aplikace není dokončena ani schválena k produkčnímu provozu.** Práce mimo aktivní relaci automaticky nepokračuje.

## Bezpečnostní brány

- [x] Živá AI volání jsou serverově vypnutá bez `JARVIS_LIVE_ENABLED=true`; Vercel Preview je vypíná i při nastavené hodnotě. Akceptace: test flagu a přímé POST `/api/chat` v Preview bez volání poskytovatele.
- [ ] Před aktivací živého režimu musí vlastník schválit design **a zabezpečení**; produkce a placené služby se schvalují samostatně.
- [~] Vlastník má stabilní explicitní UUID nezávislé na tajemstvích. Přidány pozvánky/účty se `scrypt`, deaktivace relací, oddělení paměti a obnova chybějících dat ze snapshotu bez přepsání novějších záznamů. Testy nad izolovaným PostgreSQL 16 nyní ověřují migraci i opakované spuštění z nové instance, snapshot/obnovu, tenant izolaci, single-use/expiraci pozvánek a revokaci deaktivovaného člena. Zbývá provozní backup/restore drill a test re-encryption historických ciphertextů.
- [~] Schvalování má obrazovku, owner-scoped neměnný plán a hash, append-only auditní události a dvoufázové potvrzení kritického plánu. Jednorázový `consumeApproval` atomicky přechází pouze z `approved` na `executed`; žádné externí nástroje zatím nejsou připojené. Akceptace: E2E nepřihlášeného odmítnutí, integrační DB test změněného hashe, opakovaného použití a kritických přechodů; externí akce musí spotřebovat schválení před spuštěním.
- [~] Denní výdaje mají atomickou rezervaci/settlement v PostgreSQL; paralelní specialisté rezervují vlastní worst-case náklady včetně retry, SQL test ověřuje souběh, idempotentní vypořádání a obnovu rezervací po hodině. Živý režim vyžaduje sdílenou DB a při její nedostupnosti selže uzavřeně. Akceptace: samostatný multi-instance deploy test a provozní ověření limitů ještě chybí.
- [~] Přihlášení, pozvánky, účty, paměť, schválení a chat používají sdílený PostgreSQL fixed-window limiter s hashem klíče, cleanup starých bucketů a fail-closed chybou; lokální limiter je jen pro neprodukční prostředí bez DB. Stavové browser API odmítá chybějící/cizí Origin a cross-site Fetch Metadata. Akceptace: E2E negativní CSRF a paralelní SQL testy prokazují aktuální guard; proxy/trusted `x-real-ip` je třeba potvrdit v konkrétním nasazení.
- [ ] Před nasazením vývojových agentů nahradit současné manuální AI workflow izolovaným běhovým prostředím bez přístupu k neoprávněným repozitářům a secrets a s vynucenými pravidly mimo model. Akceptace: test pokusů o únik dat, úpravu pravidel a neautorizované akce.

## Obrazovky

- [~] JARVIS Core: text, české diktování a předčítání v podporovaných prohlížečích, skutečný WebGL základ a 2D fallback. Chybí hlasové příkazy, vypínatelné zvukové efekty a ověření iOS Shortcuts. Akceptace: uživatelské testy na iPhonu včetně zamítnutí mikrofonu a omezení pohybu.
- [~] Mission Control: stávající obrazovka Orchestrace zobrazuje stav a demo; není trvalá historie úloh. Akceptace: reálný průběh a obnovená historie po přihlášení.
- [~] Agent Hub mapuje původní ID bez jejich přejmenování na Router, Researcher, Architect, Coder, Analyst, Critic a Final Judge. Router plánuje, specialisté běží ve fázích a Final Judge volá modelovou syntézu; pomocný legacy Memory agent zůstává kvůli kompatibilitě. Serverová oprávnění a nástrojová volání zatím chybí. Akceptace: test mapování starých ID, mockované integrační testy pořadí a selhání rolí.
- [ ] Research Studio: zdroje, dokumenty a analýzy. Akceptace: prokazatelné citace a práce s oprávněnými dokumenty bez neohlášených externích přenosů.
- [ ] Development Studio: autorizovaný repozitář, izolované změny, testy a PR. Akceptace: auditovatelný průchod ve schváleném rozsahu bez přístupu k produkčním tajemstvím.
- [~] Projects: pouze ukázkové položky, nikoli uživatelské projekty. Akceptace: oddělený katalog skutečných technologií a import pouze oprávněných GitHub repozitářů.
- [~] Approvals: bezpečné ukládání a schvalování konkrétních plánů včetně auditu; zatím není aktivní externí executor. Akceptace: změněný plán vyžaduje nové potvrzení, kritické akce samostatné potvrzení a jednorázová autorizace.
- [~] Memory: lokální a volitelná databázová paměť, import/export, hledání v názvu a obsahu a šifrování citlivého obsahu; databáze filtruje stabilní owner ID. Samostatní uživatelé, ověřená obnova a testy izolace tenantů chybí. Akceptace: testy izolace více účtů, obnovy, exportu a mazání.
- [~] Settings: stávající nastavení připojení, agentů, rozpočtu a hlasu; chybí účty a správa integrací. Akceptace: serverově vynucená práva a bezpečné relace.
- [~] Funkce první etapy (hlas, rutiny a analytika) jsou stále dostupné v samostatných obrazovkách; při přechodu na cílovou navigaci se nesmí ztratit.

## 3D a výkon

- [~] Three.js vykresluje jádro a síť sedmi stávajících agentů. Stav agentů mění velikost bodu, klepnutí otevře detail, paralelní 2D karty zůstávají dostupné klávesnicí. Nejde o nové agentní role.
- [~] Vykreslování měří průměr FPS v pětisekundových oknech, snižuje pixel ratio a při dlouhodobě nízkém výkonu přechází na 2D; při omezení pohybu používá 2D. Akceptace: ověřit fallback, ztrátu WebGL kontextu, uvolnění zdrojů a skutečné FPS na konkrétních iPhonech; **60 FPS nebylo na iPhonu naměřeno**.
- [~] Spojnice 3D sítě odpovídají událostem aktuálního běhu; v DEMO režimu jde o simulaci. Akceptace: automatizovaně ověřit vykreslené vazby podle událostí.

## Agenti, DeepSeek a vývoj

- [~] Server nyní používá kompatibilní mapování na cílové role Router → paralelní specialisté/fáze → Critic → Final Judge; Final Judge je skutečné volání modelové syntézy. Stále chybí izolovaná oprávnění a skutečné nástrojové volání; SSE neodesílá tokeny průběžně.
- [~] Jeden fixní read-only nástroj `search_memory` je integrován do paměťové fáze orchestrace přes reálné DeepSeek Chat Completions `tool_calls` s modelem `deepseek-flash`. Nástroj prohledává pouze paměť z ověřeného těla požadavku, omezuje počet i délku výstupů, běží nejvýše jedno kolo a každé volání modelu prochází rezervací rozpočtu. Invokace i výsledek se zapisují do stávajících run eventů; **nejde o trvalý audit**. Akceptace: mockované integrační testy úspěchu, neznámého nástroje, neplatných argumentů, omezení jednoho kola a vyčerpání rozpočtu. Chybí živé ověření, skutečná serverová oprávnění agentů a oddělený audit.
- [ ] Navrhnout a otestovat kompatibilní migraci rolí a pipeline Router → paralelní specialisté → Critic → Final Judge, skutečný tool calling, audit a pevné rozpočty. Akceptace: integrační testy s mockovaným poskytovatelem, přerušením a chybami; živý test pouze po schválení.
- [ ] Bezpečně implementovat osm vývojových rolí a posoudit Aider, OpenCode a OpenHands bez automatické instalace nebo aktivace. Akceptace: každá změna probíhá ve schválené izolované větvi s testy, PR a kontrolou oprávnění.
- [ ] Ověřit oficiální aktuální API modely a ceník před použitím; bezpečně nakonfigurovat serverový klíč zvlášť pro Vercel. Akceptace: žádný klíč v klientovi ani logu, testy retry, tool calling, streamu a účtování.

## Katalog a projekty

- [ ] Ověřit oficiální repozitáře, licence, oprávnění, způsoby integrace a náklady všech 20 požadovaných technologií. Rozlišit katalog, připravený adaptér a aktivní integraci; skutečné projekty importovat odděleně. Akceptace: každá položka má zdroj, datum ověření a přesný stav; integrace nejsou aktivovány bez souhlasu.
- Požadovaný seznam k ověření: Mastra, LangGraph.js, CrewAI; Codex, OpenCode, OpenHands, Cline, Vercel Coding Agent Template; Stagehand, Browser Use, Skyvern, Firecrawl, Open Deep Research; bolt.diy, Dyad, Playwright MCP; n8n, Mem0, MCP Servers a Langfuse. Je nutné rozlišit skutečné open-source licence od jiných licencí a neověřené údaje nepovažovat za hotové.

## Účty, paměť a schvalování

- [~] Vlastník může vytvářet jednorázové pozvánky a spravovat/deaktivovat členy; člen se přihlásí e-mailem a scrypt heslem. Paměť a schválení používají ID přihlášeného uživatele. Historie úloh, export/mazání, obnovení zálohy a DB integrační testy chybí. Přístupový kód zůstává způsobem přihlášení vlastníka. Akceptace: oddělení mezi dvěma účty, expirace/replay pozvánky, deaktivace okamžitě ruší relaci a data lze bezpečně exportovat/obnovit.
- [~] Implementovat autonomii C jako serverem vynucený auditovaný stavový automat se svázáním souhlasu s neměnným plánem. Přechody plánu a jednorázové spotřebování jsou serverové; externí akce nejsou implementované. Akceptace: integrační DB test, že žádná externí akce neproběhne bez správného souhlasu a opakované přehrání/změna plánu jsou odmítnuty.

## Testování a pokračování

- [~] `pnpm test`, `pnpm test:integration`, `JARVIS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/jarvis_test pnpm test:db`, `pnpm typecheck`, `pnpm build` a `pnpm test:e2e` jsou k dispozici. E2E zahrnuje cross-origin odmítnutí. Izolované PostgreSQL 16 ověřuje migrační obnovu, izolaci, jednorázové pozvánky, rate limiting a finanční rezervace. Stále chybí skutečný multi-instance Vercel DB test, reálné iPhone testy, E2E pozvaného účtu s DB a ověření FPS/spotřeby.
- [x] Copilot Code Review: workflow guard detekuje staged i unstaged `.github/workflows` změny; výsledek běhu je viditelný v obrazovce Tok; nepodporovaný hlasový vstup přejde na fokusovaný textový kompozitor. Akceptace: unit test workflow guardu a 2 Playwright scénáře.
- [ ] Po každé změně zkontrolovat skutečné Preview deploymenty i chování aplikace; stav „build passed“ sám nestačí.
- Pokračování: zkontrolovat aktuální stav PR #1 a pracovní strom; navázat bez přepsání dat. Nejdříve dokončit bezpečnostní hranice, účty a migrační strategii; všechny implementační fáze průběžně ověřovat. Neaktivovat AI, další placené služby ani produkci bez výslovného souhlasu.
