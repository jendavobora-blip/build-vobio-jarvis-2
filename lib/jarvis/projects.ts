export interface JarvisProject {
  id: string
  name: string
  category: "AI" | "Byznys" | "Produktivita" | "Výzkum"
  description: string
  prompt: string
}

export const PROJECTS: JarvisProject[] = [
  { id: "jarvis", name: "VOBIO JARVIS", category: "AI", description: "Osobní multiagentní velitelské centrum.", prompt: "Navrhni další bezpečný a užitečný krok pro projekt VOBIO JARVIS." },
  { id: "agent-lab", name: "Agent Lab", category: "AI", description: "Prototypování spolupráce specializovaných agentů.", prompt: "Připrav návrh experimentu pro Agent Lab." },
  { id: "voice-cz", name: "Český hlas", category: "AI", description: "Hlasové ovládání a přístupnost v češtině.", prompt: "Navrhni testovací plán pro české hlasové ovládání." },
  { id: "memory-vault", name: "Memory Vault", category: "AI", description: "Soukromá a přenositelná znalostní paměť.", prompt: "Navrhni bezpečný model osobní paměti." },
  { id: "vobio-studio", name: "VOBIO Studio", category: "Byznys", description: "Pracovní prostor pro nápady a digitální produkty.", prompt: "Připrav pracovní plán pro VOBIO Studio." },
  { id: "market-map", name: "Market Map", category: "Výzkum", description: "Strukturovaný přehled trhu a ověřitelných zdrojů.", prompt: "Vytvoř rámec rešerše trhu včetně zdrojů k ověření." },
  { id: "idea-forge", name: "Idea Forge", category: "Byznys", description: "Proměna nápadů v ověřitelné hypotézy.", prompt: "Vyhodnoť nápad podle problému, cílové skupiny a rizik." },
  { id: "focus-flow", name: "Focus Flow", category: "Produktivita", description: "Plánování soustředěné práce a priorit.", prompt: "Pomoz mi rozdělit dnešní práci na realistické priority." },
  { id: "signal-watch", name: "Signal Watch", category: "Výzkum", description: "Evidence signálů, trendů a nejistot.", prompt: "Navrhni způsob, jak odlišovat signály od šumu." },
  { id: "launch-kit", name: "Launch Kit", category: "Byznys", description: "Kontrolní seznam pro uvedení produktu.", prompt: "Připrav kontrolní seznam pro bezpečné uvedení digitálního produktu." },
  { id: "content-engine", name: "Content Engine", category: "Byznys", description: "Český obsahový plán s lidskou kontrolou.", prompt: "Navrhni obsahový plán na jeden měsíc v češtině." },
  { id: "knowledge-garden", name: "Knowledge Garden", category: "Produktivita", description: "Propojování poznámek, zdrojů a rozhodnutí.", prompt: "Navrhni jednoduchou strukturu osobní znalostní báze." },
  { id: "risk-radar", name: "Risk Radar", category: "Výzkum", description: "Včasné pojmenování rizik a předpokladů.", prompt: "Proveď předběžnou analýzu rizik tohoto projektu." },
  { id: "budget-compass", name: "Budget Compass", category: "Byznys", description: "Plánování nákladů bez automatických transakcí.", prompt: "Vytvoř konzervativní rozpočet s jasně označenými předpoklady." },
  { id: "research-desk", name: "Research Desk", category: "Výzkum", description: "Opakovatelný postup pro rešerši a ověřování.", prompt: "Navrhni rešeršní postup a seznam typů zdrojů k ověření." },
  { id: "decision-log", name: "Decision Log", category: "Produktivita", description: "Záznam rozhodnutí, důvodů a otevřených otázek.", prompt: "Připrav šablonu stručného záznamu rozhodnutí." },
  { id: "product-blueprint", name: "Product Blueprint", category: "Byznys", description: "Od problému k ověřitelnému produktovému zadání.", prompt: "Vytvoř produktové zadání včetně cílové skupiny a metrik." },
  { id: "code-reviewer", name: "Code Reviewer", category: "AI", description: "Kontrola změn se zaměřením na regresní rizika.", prompt: "Připrav checklist pro bezpečnou kontrolu změn v aplikaci." },
  { id: "wellbeing-routine", name: "Daily Rhythm", category: "Produktivita", description: "Udržitelná denní rutina a přehled úkolů.", prompt: "Navrhni nenáročnou denní rutinu pro soustředěnou práci." },
  { id: "vision-board", name: "Vision Board", category: "Byznys", description: "Převod dlouhodobé vize na měřitelné milníky.", prompt: "Rozděl dlouhodobou vizi na ověřitelné milníky." },
]

export function filterProjects(query: string, category = "Vše"): JarvisProject[] {
  const normalized = query.trim().toLocaleLowerCase("cs-CZ")
  return PROJECTS.filter((project) => {
    const matchesCategory = category === "Vše" || project.category === category
    const matchesQuery =
      !normalized ||
      `${project.name} ${project.description} ${project.category}`.toLocaleLowerCase("cs-CZ").includes(normalized)
    return matchesCategory && matchesQuery
  })
}
