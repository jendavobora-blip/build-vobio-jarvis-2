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

Vlastník se stále přihlašuje přístupovým kódem; může vytvořit jednorázovou 24hodinovou pozvánku, která se předá ručně, a deaktivovat pozvané účty. Členové používají unikátní e-mail a scrypt-hashované heslo; relace se ověřuje proti aktivnímu účtu. Každý účet má oddělené paměťové a schvalovací záznamy. Pozvánky se e-mailem neposílají. Omezení pokusů o přihlášení je zatím pouze po instanci, ne distribuované.

Schvalování ukládá plán, audit a stav; ani schválený plán nyní nespustí externí akci. Budoucí nástroj musí před akcí atomicky spotřebovat odpovídající schválení podle uživatele a přesného hashe plánu. Kritické plány vyžadují dvě oddělená potvrzení.
