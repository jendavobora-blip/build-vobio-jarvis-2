# Serverová konfigurace identity a paměti

Živý AI backend zůstává standardně vypnutý a v prostředí Vercel Preview je vždy zakázán.

## Oprava chráněného Vercel Preview

Změny konfigurace a redeploy proveďte až po schválení konkrétního plánu vlastníkem a úspěšných kontrolách opravného PR. V nastavení projektu Vercel `vobio-jarvis` vyberte **Preview**, případně pouze zamýšlenou větev; neměňte Production ani `main`. Zachovejte Deployment Protection. GitHub Actions secrets se do Vercelu automaticky nepřenášejí.

1. Připravte oddělený Preview PostgreSQL s povoleným TLS, ověřenou konektivitou z Vercelu a vlastním zálohováním. Nepoužívejte produkční databázi ani testovací DB, jejíž schéma testy mažou. Před použitím existující databáze ověřte zálohu a migrační postup níže.
2. Ve Vercel **Settings → Environment Variables** pro Preview nastavte `DATABASE_URL` na připojení k této DB, `JARVIS_OWNER_ID` na stabilní UUID vlastníka, `JARVIS_ACCESS_CODE` na kód alespoň 8 znaků a nezávislé `JARVIS_SESSION_SECRET` a `JARVIS_ENCRYPTION_KEY` každý alespoň 32 UTF-8 bajtů. Použijte správce tajemství, nikoli chat, commit či log. Existující identitu ani šifrovací klíč svévolně nerotujte: znepřístupnilo by to data.
3. Pouze pokud je to schváleno, nastavte v tomtéž Preview prostředí serverový `DEEPSEEK_API_KEY` ze správce tajemství. Jeho přítomnost jen nastaví indikátor; nezapínejte placená volání. `JARVIS_LIVE_ENABLED` ponechte vypnutý: Preview je navíc serverově blokováno i při `true`.
4. Po úspěšných kontrolách redeployujte schválený opravný commit jako Preview, nikoli Production. Ověřte nasazený SHA a přes chráněný přístup HTTPS `/api/status`: `authConfigured` a `databaseConfigured` mají být `true`, `deepseekConfigured` jen pokud byl klíč nastaven, a `liveEnabled` musí být `false`. Tyto indikátory kontrolují přítomnost a formát konfigurace, nikoli připojení k DB či platnost klíče.
5. Bez volání AI otestujte přihlášení dvou testovacích účtů, historii a odhlášení/přepnutí ve dvou záložkách. Ověřte také `GET /api/github/repository?owner=...&repo=...` s veřejným repozitářem. V produkčním buildu tento endpoint vyžaduje funkční sdílený PostgreSQL limiter: chybějící či nedostupná DB může vrátit 503 „Sdílená ochrana požadavků není dostupná“, případně „Sdílená ochrana GitHub API není dostupná“. Pokud 503 přetrvá, zkontrolujte bezpečně serverové logy, DB připojení, migrace a odchozí HTTPS na GitHub; 429 znamená limit, nikoli chybějící klíč. Žádné hodnoty tajemství nevypisujte.

## Stabilní vlastník

Databázové nasazení musí mít samostatně nastavené:

- `JARVIS_OWNER_ID`: UUID vlastníka. Je to trvalý identifikátor účtu, nikoli odvozenina hesla, API klíče, session secretu nebo šifrovacího klíče. Při rotaci jiných tajemství jej neměňte.
- `JARVIS_ACCESS_CODE`: přístupový kód pro současný jednovlastnický přihlašovací model.
- `JARVIS_SESSION_SECRET`: nezávislé náhodné tajemství o délce alespoň 32 bajtů pro podpis relací.
- `JARVIS_ENCRYPTION_KEY`: nezávislé tajemství o délce alespoň 32 bajtů pro AES-GCM citlivých položek.

Chybějící nebo neplatný `JARVIS_OWNER_ID` blokuje přihlášení a databázové operace místo odvození nového vlastníka. Rotace session tajemství odhlásí relace, ale nezmění vlastníka. Rotace šifrovacího klíče vyžaduje samostatnou re-encryption migraci; bez ní se starší záznamy nesmí mazat ani přepsat.

Lokální paměť přihlášeného účtu je v prohlížeči oddělena podle serverem podepsaného account scope. Rotace session secretu změní i tento scope: staré lokální položky se nesmažou, ale nebudou automaticky přístupné. Před rotací zajistěte jejich bezpečný export a postup obnovy.
Starý společný klíč `vobio-jarvis.memory.v1` se již automaticky nezobrazuje ani nemaže: mohl obsahovat data více lidí. Případnou migraci musí provést vlastník zařízení až po ověření původu jednotlivých položek. Klient cloudové paměti zasílá `X-Jarvis-Account-Scope` získaný ze `/api/status`; server odmítne požadavek s neodpovídajícím scope.

## Migrace původní paměti

První spuštění nové migrace v jedné databázové transakci uloží dosavadní řádky do `jarvis_memories_owner_backup`, převede původní jednovlastnické záznamy na nakonfigurované UUID a změní klíč tabulky na `(id, owner_id)`. Záloha je zachována pro obnovu. Migrace se zaznamená do `jarvis_schema_migrations` a znovu nepřiřazuje později vytvořená uživatelská data.

Před migrací zachovejte databázovou zálohu. Pokud starší citlivá data byla zašifrována původním klíčem, nastavte dočasně `JARVIS_LEGACY_ENCRYPTION_KEY` na původní materiál klíče ze správce tajemství. U dřívější konfigurace bez explicitního session secretu šlo o původní hodnotu odvozenou ve formátu `derived:<původní přístupový kód>:<původní DeepSeek klíč nebo no-key>`. Hodnotu nikam nevkládejte do repozitáře, issue, logu ani chatu. Po ověření obnovy proveďte samostatnou řízenou migraci šifrování; tato verze automaticky staré ciphertexty nepřepisuje.

## Účty a schválení

Vlastník se stále přihlašuje přístupovým kódem; může vytvořit jednorázovou 24hodinovou pozvánku, která se předá ručně, a deaktivovat pozvané účty. Členové používají unikátní e-mail a scrypt-hashované heslo; relace se ověřuje proti aktivnímu účtu. Každý účet má oddělené paměťové a schvalovací záznamy. Pozvánky se e-mailem neposílají.

V produkci se přihlášení, pozvánky, paměť, schválení a živé chat požadavky omezují přes PostgreSQL sdílený pevný interval; chyba sdíleného limiteru blokuje požadavek. IP klíč bere pouze důvěryhodný `x-real-ip` a v databázi ukládá jeho hash. Lokální limiter se používá pouze mimo produkci bez databáze. Stavové browser API vyžaduje přesný `Origin` shodný s cílovým originem a odmítá `Sec-Fetch-Site: cross-site`.

Denní výdaje se rezervují atomicky v PostgreSQL před voláním modelu. Po skončení běhu se rezervace převede na skutečné účtování; chyba databáze při rezervaci živé volání zablokuje. Neuzavřené rezervace starší než hodina se před dalším během uvolní po havárii instance. Živý režim vyžaduje nakonfigurovanou databázi.

Schvalování ukládá plán, audit a stav; ani schválený plán nyní nespustí externí akci. Budoucí nástroj musí před akcí atomicky spotřebovat odpovídající schválení podle uživatele a přesného hashe plánu. Kritické plány vyžadují dvě oddělená potvrzení.

## Izolované databázové testy

`pnpm test:db` záměrně maže schéma `public`; spusťte jej výhradně proti vyhrazené zahoditelné databázi `jarvis_test` na loopbacku. Test ověřuje migraci staré paměti, opakované spuštění migrace z nové instance, obnovu ze snapshotu, izolaci účtů, pozvánky, distribuovaný limiter a souběžné rezervace rozpočtu. Nezadávejte produkční `DATABASE_URL`.

```sh
docker run --rm --name vobio-jarvis-pg-test \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=jarvis_test \
  -p 127.0.0.1:55432:5432 -d postgres:16-alpine
JARVIS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/jarvis_test pnpm test:db
docker stop vobio-jarvis-pg-test
```
