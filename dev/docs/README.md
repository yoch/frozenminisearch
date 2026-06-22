# Notes de conception (développeurs)

Documents de référence pour des mécanismes internes — **non** inclus dans l’API publique npm.

| Document | Sujet |
|----------|--------|
| [FREQ_ADAPTIVE_RECAP.md](./FREQ_ADAPTIVE_RECAP.md) | Largeur adaptative u8/u16 sur `allFreqs`, parité BM25, flags wire |
| [AND_GATE_PARAMETERS.md](./AND_GATE_PARAMETERS.md) | Heuristiques de gating AND / AND_NOT (`queryEngineGateLimits.ts`) |

Ces fichiers sont la **source versionnée**. `pnpm build-docs` copie aussi leur contenu dans `docs/media/` pour le site TypeDoc (généré localement, gitignored).
