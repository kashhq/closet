# Outfit rules: "never X with Y", "always X with Y" (#21)

Status: approved by the owner 2026-11-12, with every recommended option.

## 1. What exists

- `generator_avoid` (gallery #9, "Say why not"): two specific garments the owner said clash. The
  generator never combines them again (`hardRules().compatible`, `src/wardrobe/generator.ts`).
- Everything that suggests outfits goes through `generateIdeas`: Ideas, Today, Styling's shuffle,
  the week planner (`week-planner.ts`), Goes-with's best outfits, MCP `suggest_outfits` and `plan_week`.
  So one rule check there reaches them all.

## 2. The rule model

A rule is `kind` (never | always), plus two **matchers**, A and B. A matcher is one of:
- a garment (`garment_id`);
- a category (`category`), with an optional type;
- a colour (`GARMENT_COLORS`);
- a pattern (`properties.ts` patterns).

So "never navy with black" is two colour matchers, "never sneakers with a suit" is a type and a
category, and "always the brown belt with the brown shoes" is two garments.

- **never A with B**: no outfit holds a garment matching A and a different garment matching B.
  An outfit stays broken whatever is added, so it joins `compatible`, which keeps the draw's
  early pruning sound.
- **always B with A**: an outfit holding an A also holds a B, *when a B is drawable* (in the pool,
  and its role is free or B is in the outfit's roles). Adding a B fixes an outfit that breaks this,
  so it can't join `compatible`. It joins `passes` (the final check), and the drawer gets one repair
  step: when the outfit has an A and no B, swap in a B for its role's slot before the outfit is judged.
  With no B drawable the rule is moot, because an always-rule must never empty Ideas.
- **Locked garments** (Styling's locks, `?with=`) that break a rule are still shown. The idea is
  flagged with a new `IdeaProblem`, `'breaks-rule'`, and the rule's text, as `too-casual` flags formality.

`generator_avoid` stays as it is: a learned pair with its own writers and cascades. The generator
compiles both into one rule list (a pair becomes a never-rule with two garment matchers), so there's
one place that enforces rules.

## 3. Storage

`outfit_rule` (owner_id, id, kind, a_garment_id | a_category + a_type | a_color | a_pattern, the
same for b, created_at):
- check constraints: exactly one matcher per side, and the value sets from `properties.ts`;
- the garment foreign keys are indexed and `ON DELETE CASCADE`, so a deleted garment takes its rules;
- unique on (owner, kind, a, b), so a rule is stored once.

It's the owner's own, like the style profile: no `?ownerId=`, and a grantee's ideas don't use the
owner's rules.

## 4. Surfaces

- **Style profile › Outfit rules** (`src/web/style/`):
  - the rules listed as sentences ("Never navy with black");
  - an add form (kind, then A and B, each a garment picker or a property select), a native `PostForm`;
  - delete per rule;
  - the gallery's avoided pairs listed below, read-only, with "Allow again" (`allowPair`).
- **Ideas and Styling:** a broken-rule chip on a flagged idea, using the problems' existing markup.
- **MCP:** `get_style_profile` lists the rules, so Muse respects them. A write tool waits for the
  owner's need.

## 5. Tests and budget

- **Unit** (`generator.spec.ts`): each kind and matcher type; a never-rule prunes the draw (counted);
  the always-rule repair; moot with no B; locked and flagged.
- **Integration:** the routes (the add form, a 400 for a bad matcher, the owner-only refusal through
  the authorization matrix); Ideas honouring a rule end to end; and a statement count, since the rules
  are read in the ideas statement and add no round trip.
- **No new Playwright scenario.**

## 6. Slices

- **21a:** the table, the generator, the unit specs.
- **21b:** the Style page section and its routes.
- **21c:** the chips, and MCP's `get_style_profile`.
