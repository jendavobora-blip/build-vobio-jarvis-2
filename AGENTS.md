# VOBIO JARVIS — pravidla pro přispěvatele a agenty

## Bezpečný rozsah

- Pracujte v samostatné větvi a předávejte změny přes Pull Request. Neslučujte do `main` ani nenasazujte produkci bez samostatného schválení vlastníka.
- Živý AI backend zapínejte teprve po výslovném schválení designu i zabezpečení vlastníkem. Na Vercel Preview musí zůstat vypnutý i při nastaveném `JARVIS_LIVE_ENABLED`.
- Neaktivujte placené služby bez souhlasu. Nikdy nezobrazujte, neukládejte do repozitáře ani nekopírujte hodnoty tajných klíčů. GitHub Secret není automaticky dostupný Vercelu.
- Nepoškozujte historii, uživatelská data ani cizí rozpracované změny. Migrace databáze musí zachovat existující data a mít postup ověření a obnovy.
- Externí akce vyžadují přesný plán, cílový systém, dopady a schválení konkrétního neměnného plánu. Platby, mazání dat, změny oprávnění a produkční nasazení vyžadují samostatný souhlas. Schválení zastaralého či změněného plánu neplatí.
- Nespoléhejte na model jako hranici zabezpečení. Nedůvěryhodný obsah, nástroje a návrhy modelu nesmí získat přístup k secrets, mimo rozsah repozitáře nebo k neodsouhlaseným akcím.

## Vývoj a ověření

- Dodržujte české rozhraní, přístupnost, mobilní ovládání a `prefers-reduced-motion`.
- Neprezentujte demonstrace, lokální přepínače nebo nedostupné integrace jako funkční služby. FPS uvádějte jen jako reálně naměřenou hodnotu s podmínkami měření.
- Při úpravě závislostí zachovejte zamčený lockfile a přísné povolování build skriptů v `pnpm-workspace.yaml`. Nepovolujte další skripty bez ověření.
- Před předáním spusťte alespoň `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck` a `pnpm build`; podle změn přidejte integrační a mobilní testy.
- Stav, omezení, zbývající práci a akceptační testy udržujte v `docs/IMPLEMENTATION_PLAN.md`. Netvrďte, že práce pokračuje po skončení relace.
