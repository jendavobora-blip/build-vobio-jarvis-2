# Pokyny pro VOBIO JARVIS

Před změnami si přečtěte `AGENTS.md` a `docs/IMPLEMENTATION_PLAN.md`. Základní pravidla:

- Komunikujte česky; provádějte skutečné, úzce vymezené a ověřené změny.
- Chraňte existující data, historii, secrets a uživatelská oprávnění. Připravujte kompatibilní, nedestruktivní migrace.
- Vývoj probíhá ve větvi a přes PR. Produkci, slučování, placené služby a spuštění živého AI backendu neprovádějte bez příslušného souhlasu vlastníka.
- Preview nesmí volat živý AI backend. Externí a rizikové akce musí mít konkrétní schválený plán; kritické akce vyžadují samostatné potvrzení.
- Jasně rozlišujte skutečné schopnosti, demo a neimplementované integrace. Aktualizujte stav a akceptační testy v implementačním plánu.
- Ověřujte změny testy, TypeScriptem, buildem a podle potřeby integračně i na mobilu. Nepředpokládejte, že úspěšný build prokazuje funkčnost.
