# Module ownership

| Path | Owner | Depends on |
|---|---|---|
| `src/types.ts` | foundation (frozen) | — |
| `schema.sql` | foundation (frozen) | — |
| `src/lib/log-parser.ts` | Agent A | types |
| `src/lib/vector.ts` | Agent A | types |
| `src/lib/d1.ts` | Agent B | types, vector |
| `src/workflow.ts` | Agent B | types, d1, ai/* |
| `src/repo-state.ts` | Agent B | types |
| `src/index.ts` | Agent C | everything |
| `src/ai/*.ts` | Agent C | types |
| `public/*` | Agent D | HTTP contract in types.ts |

Nobody edits `src/types.ts` or `schema.sql`. If the contract is wrong, report it
rather than changing it.
