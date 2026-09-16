# Selected onboarding checklist direction

This branch retains only the selected **Rail esencial** direction. The seven
discarded alternatives and the prototype picker have been removed so the
handoff diff stays focused. The surface remains deliberately isolated from the
production application: no production route imports it and the normal Vite
build only uses `frontend/index.html`.

## Run

```bash
cd frontend
corepack pnpm@11.5.1 dev --host 127.0.0.1 --port 5174 --strictPort
```

Open `http://127.0.0.1:5174/prototypes/onboarding-checklist/` in Google Chrome.

## Selected direction

The main surface contains one horizontal timeline with six aligned pills:
Tablero, Definición, Notas, Equipo, Canal and Git. A thin dotted line behind
the pills communicates progress without becoming the dominant visual element.

Each pill opens the shared modal with the existing long title, hint, status,
optional marker, explanation, bullets, Backplane illustration and matching
mini-form. The initial snapshot has five of six areas complete and Canal as the
remaining action. The top-bar theme control switches between light and dark.

## Handoff scope

This commit is a visual and interaction reference for consolidation by
Sebastián. It does not replace the production `OnboardingChecklist` yet. When
promoting it to `main`, connect the selected structure to the real checklist
queries and mutations, use localized copy for every supported locale, preserve
the production persistence rules, update the product tests and then remove this
isolated prototype surface.
