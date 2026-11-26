# Serverová konfigurace identity a paměti

Živý AI backend zůstává standardně vypnutý a v prostředí Vercel Preview je vždy zakázán.

## Stabilní vlastník

Databázové nasazení musí mít samostatně nastavené:

- `JARVIS_OWNER_ID`: UUID vlastníka. Je to trvalý identifikátor účtu, nikoli odvozenina hesla, API klíče, session secretu nebo šifrovacího klíče. Při rotaci jiných tajemství jej neměňte.
- `JARVIS_ACCESS_CODE`: přístupový kód pro současný jednovlastnický přihlašovací model.
- `JARVIS_SESSION_SECRET`: nezávislé náhodné tajemství o délce alespoň 32 bajtů pro podpis relací.
- `JARVIS_ENCRYPTION_KEY`: nezávislé tajemství o délce alespoň 32 bajtů pro AES-GCM citlivých položek.

Chybějící nebo neplatný `JARVIS_OWNER_ID` blokuje přihlášení a databázové operace místo odvození nového vlastníka. Rotace session tajemství odhlásí relace, ale nezmění vlastníka. Rotace šifrovacího klíče vyžaduje samostatnou re-encryption migraci; bez ní se starší záznamy nesmí mazat ani přepsat.

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
