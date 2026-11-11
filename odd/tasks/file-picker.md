# File picker panel

A `/gentle:files` overlay panel that browses the repository's files with a live preview, and inserts the chosen path into the prompt.
Branch `feat/file-picker`, worktree `gentle-shell-worktrees/file-picker`, cut from `main`.

## Specs

S1. **Panel chrome.** Centered overlay styled exactly like the Customization panel: `╭─╮` card frame, title at the top-left, `esc` hint at the top-right. Title text: `File picker`.

S2. **Two panes.** A file list on the left and a file preview on the right, separated by a vertical rule. The list shows repository-relative paths.

S3. **Scrollable preview.** The preview scrolls with the mouse wheel and with `ctrl+j` / `ctrl+k`, plus `ctrl+shift+j` / `ctrl+shift+k` for terminals where `ctrl+shift+<letter>` is the only deliverable form ("ctrl j/k + ctrl shift j/k adicional para compatibilidad linux"). Scrolling is bounded: the preview reads at most a fixed byte budget, marks a truncated preview explicitly, and renders a binary file as a notice instead of bytes. No file may stall the render.

S4. **Keybinding footer.** One footer line listing the panel's keys, in the same style as the Customization panel's `Click · ←/→ or Tab panes · ↑/↓ move · Enter apply · p profiles · Esc close`.

S5. **Search always active.** Typing filters the list immediately; there is no mode to enter, exactly like the Commands palette ("ahi directeamnte el searh esta siemrpre activo"). Navigation and scroll use modifier combinations so plain characters always reach the query: `ctrl+j` / `ctrl+k` move the selection, `ctrl+shift+j` / `ctrl+shift+k` scroll the preview, `↑` / `↓` also move, `backspace` edits the query, `ctrl+u` clears it. A query matching nothing shows an explicit empty-state line.

S6. **Everything clickable.** Clicking a list row selects it; clicking the preview does not break the panel; the wheel over the list moves the selection; the wheel over the preview scrolls the preview. Pointer geometry is rebuilt on every render so clicks always match what is painted.

S7. **Open in the editor.** `ctrl+e` opens the highlighted file in `$VISUAL`/`$EDITOR` through the same helper `/changes` uses, and reports `No editor configured. Set $VISUAL or $EDITOR.` when neither is set.

S8. **Enter inserts and closes.** `Enter` inserts the highlighted file's reference into the prompt input and closes the panel, leaving focus in the input. It does not send the message. With a Tab selection in place it emits every selected file (S14), and the reference form follows S16/S17. ("lo de enter me parece bien insertar y cerrar panel, como el de fzf funciona asi")

S9. **Opener.** A `/gentle:files` command and a keymap action `files` that opens the panel. Default key `alt+p`, overridable in Customization → Keymaps and through its environment variable, following the existing `KEYMAP_ACTIONS` contract. `ctrl+f` stays available by assignment rather than as the default, so the panel does not take `ctrl+f` away from Pi's editor cursor binding (decision accepted in L2 after the parent's recommendation).

S10. **Listing source.** The list comes from Git (`git ls-files`-style), so tracked files and untracked-but-not-ignored files appear and `.gitignore` is respected. Outside a Git repository, or with an empty result, the panel shows an explicit message instead of an empty card.

S11. **No regressions.** Existing keymap, palette and changes tests keep passing; a new keymap action must be reflected in the keymap defaults test and in the docs that list keys and commands.

S12. **Changed files first, with state and age.** Files changed in the working tree sort above unchanged ones. A newly created file shows `new`, a modified tracked file shows `upt`, and both show their age at the right in `s`/`h`/`d` units. Ages are computed once when the panel opens and are never recomputed or refreshed live ("igual esto se calcula al abrir no se recalcula/actualiza en vivo").

S13. **Clear-search key.** `ctrl+u` clears the query and the footer lists it alongside the other keys.

S14. **Tab multi-select.** `Tab` toggles the highlighted file in a selection that is visually distinguished from the plain highlight. `Enter` emits every selected file, including the highlighted one when it was not selected yet, never duplicating a file that is already selected, and then leaves focus. ("con "tab" como keybindg select como en zft ... los seleccionador los resalta y luego con enter manda todos los seleecionado (incluyendo al que le dio enter, enter lo agrega seleccionado y manda el focus ... no se agrega seleecionado uno que ya esta)")

S15. **Worktree scope selector.** When the session has registered worktrees, opening the file picker first shows a scope selector with `main` (the session repository) plus every registered worktree, most recently modified first. `Enter` on a scope opens the picker on that path and lists that path's files. With no registered worktree the picker opens directly on the current path, so the extra step never appears when it has nothing to offer.

S16. **Reference form.** A file from the current session path is inserted as `@` plus the repository-relative path (`@AGENTS.md`, `@src/index.ts`, `@themes/Gentle.json`), which is how Pi resolves it against the current path. A file from a registered worktree is inserted as its full absolute path, because `@` would resolve against the current path and point at the wrong file ("si manda el de un worktre es diferente, ahi el "@" no sirve pues es otra ruta, en ese caso debe mandar/pegar la ruta completa").

S17. **Multi-file insertion.** Several selected files are inserted space-separated, in list order.

S18. **Search row.** A `›` prompt row sits directly under the title and shows the typed query (with a placeholder when empty), followed by a blank row and then the list — the same shape as the Commands panel and fzf. No separate "type to search" hint.

S19. **One option per key in every hint line.** A hint names a single binding per action even when several are functional: `esc` (not `esc/ctrl+c`), arrows for move, `ctrl+j/k` for preview scroll (not the `ctrl+shift` fallback). Both keys keep working. This applies to the picker, the scope step and the existing `/changes` view.

S20. **Stable row geometry when marking.** `Tab` must repaint the row in place: the cursor/selection marker occupies a constant width, so a marked row never shifts left or right, and the shift never lingers until the next key.

S21. **Preview gutter and position.** The preview shows line numbers in a left gutter and the position of the top visible line as `line/total` at the preview's top-right, using the Pi theme colours.

S22. **Picker geometry.** The panel is narrower and taller than the first cut: it must use the vertical room the terminal offers instead of a wide, short card, matching the Commands panel's proportions.

S23. **Editor handoff without jank.** Opening `$EDITOR` from the picker and returning must feel the same as in `/changes`: no extra full repaint before the terminal is stopped.

S24. **`ctrl+j/k` and `ctrl+shift+j/k` both scroll the preview**; arrows move the selection. The `ctrl+shift` form exists only as a Linux-compatibility fallback for the same action.

S25. **`.gitignore` is respected.** The listing excludes ignored paths; confirm with evidence rather than assuming.

S26. **Listing path in the title row.** The picker's title row shows the path being listed, at its top-right next to the `esc` hint, so the user can see which scope (session repository or a registered worktree) the list belongs to. "Falta conectar scope.root al encabezado del picker, verificar que se vea la ruta del scope elegido"

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S3, S10 | gentle-ai-worker: `lib/file-index.ts` + tests | `0a9c81cd4` |
| T2 | S1-S6, S11 | gentle-ai-worker: `lib/file-picker-view.ts` + tests | `f870d241a` |
| T3 | S7, S8, S9, S16, S17, S11 | gentle-ai-worker: command wiring, keymap action, insertion form, docs | `e4d936b85` |
| T4 | S12 | gentle-ai-worker: index reports change state and mtime (reopens T1's surface) | `7e28cc9eb` |
| T5 | S12, S13, S14 | gentle-ai-worker: row badges, Tab multi-select, footer `ctrl+u` (reopens T2's surface) | `3832a850c` |
| T6 | S15 | gentle-ai-worker: worktree scope selector + scope-first flow | `8c078277a` |
| T7 | S11 | verify: typecheck + full suite | done |
| T8 | S16, S7, S8, S15, S11 | gentle-ai-worker: `@` from the session cwd, `try/finally` close, `/changes` roots parity, docs truth and wiring coverage (reopens T2/T3/T6 surfaces) | `1eab97ea4` |

## Delivery

Slice boundary after T4/T6: 2049 authored changed lines in 4 commits on `feat/file-picker` (from `main` at `29b57a414`), which is past the ~400-line review slice. Recorded per commit:

| Task | Commit |
| --- | --- |
| T1 | `0a9c81cd4` feat(files): add the file index and bounded preview reader |
| T2 | `f870d241a` feat(files): add the file picker overlay component |
| T4 | `7e28cc9eb` feat(files): report per-file change state, mtime and age |
| T5 | `3832a850c` feat(files): show change state and age, and select multiple files |
| T6 | `8c078277a` feat(files): add the worktree scope selector |
| T3 | `e4d936b85` feat(files): open the picker from /gentle:files and alt+p |
| T8 | `1eab97ea4` fix(files): resolve @ against the session cwd and harden the picker |

Final verification of the committed branch, run with dependencies available:

- unit stage `node --experimental-strip-types --test tests/*.test.ts`: 9610 tests, 9488 pass, 28 fail; the failing-name set is byte-identical on a clean clone of the branch head, and every one of those names also fails at the base commit — pre-existing session-profile, review-assess and admission tests, none touching this feature.
- focused set (insert, picker view, scope view, shell extension, palette, keymaps): 473 tests, 473 pass, 0 fail.
- `node scripts/check-types.mjs`: 0 recorded diagnostics, no regressions.
- `node scripts/check-provider-contract.mjs`: passed (contract 1.4.0, 10 bundle entries).
- `node --experimental-strip-types tests/runtime-harness.mjs`: exit 0.

L11 (user, verbatim, with the attached screenshots marked):

> [Image#2] [Image#6] funciona pero varios errores, primero no aparece search arriba deberia ser como en comand que justo debajo sale search y lo que tupeo y luego un espacio con lo demas [Image#3] [Image#4] en el de fish igual  es asi.
>
> en keybinding "type to search" esta demas, ctrl j/k y ctrl+shift j/k esta duplicado, te dije que ambos son el mismo, para el scroll de preview, pero el de shift es un extra para linux, en keybinding solo basta con poner ctrl j/k scroll. [Image#5] al hacer tab si te fije el ticket queda mas a la izquierda, no es hasta que me muevo que se arregla, eso esta mal.
>
> giual no pongas atajos dobles, como en escoger scope pusiste esc/ctrl c, esta bien poner 2 atajos compatible pero deja en el texto solo una opcion ahi deja "esc", esto aplica a todos. lo mismo con move, seria solo flechas en texto.
>
> [Image#7] aqui los puse sobrepuesto para que notes diferencias, deberia ser algo mas angosto, o dejar ese ancho per mucho mas alto.
>
> Ademas ve si es posible que la preview tenga color, siga el color del tema de pi, solo si no es complejo porque el color del codigo varia segun el elenguajes, si es muy costoso no. Peri si como en el ejemplo agrega a la izquierda del preview las linea que es, [Image#8] y arria derecha que linea esta/total lineas.
>
> Igual nose si ya lo hace sino agrega que respete gitignore.
>
> Igua al abrir con edit el archivo y luego cerrarlo da un tiron, noes muy fluiodo, revisa como funciona ahi en /changes haber si se paso algo. en esa vista igual hay atajos duplicados/con 2 opciones que dijimos esta mal, solo mostrar una ,dejar funcional ambas.

L12 (parent, decisions): L11 is a requirement change, recorded as S18-S25. Two calls I am making on the user's behalf because the requirement leaves the cost to me: syntax highlighting per language is NOT implemented (it would need a parser per language or a dependency, and the user explicitly said to skip it when costly); instead the preview gets a line-number gutter and a `line/total` position indicator in the Pi theme colours, which is what the screenshots actually show. And S24 settles a real behaviour conflict in the first implementation: `ctrl+j/k` now scrolls the preview (it used to move the selection), arrows move, and the `ctrl+shift` form is an alias for the same scroll action, not a second binding for a different one.

Tasks for L11 (all reopen surfaces already delivered):

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T9 | S18, S19, S20, S21, S24 | gentle-ai-worker: picker search row, footer, marker width, gutter and position, scroll keys | `19cdee579` |
| T10 | S19, S25 | gentle-ai-worker: single-option hints across scope and `/changes`, gitignore evidence, docs | `3475feb69` |
| T11 | S22, S23 | gentle-ai-worker: overlay geometry and editor handoff parity with `/changes` | `8dbf6c7d7` |
| T12 | S26, S1 | gentle-ai-worker: pass scope.root into the picker header + extension regression test + docs | `8dbf6c7d7` |

Final branch shape: 2557 authored changed lines in 6 commits. T5 and T3 added the two remaining units.

T5 and T3 add two more units. Because the whole branch exceeds one reviewable slice, delivery follows `gentle-ai-chained-pr`: a tracker PR plus one chained PR per unit, with T3 last because it carries the command, the keymap action and the docs that make the feature reachable. Nothing is pushed without the human's decision.

Slice boundary after T9/T10/T11/T12: the round is covered by exactly three work-unit commits, which brings `feat/file-picker` to ten commits against `origin/main`. Recorded per commit:

| Task | Specs | Commit |
| --- | --- | --- |
| T10 | S19, S25 | `3475feb69` refactor(files): name one option per action in the scope and changes hints |
| T9 | S18, S19, S20, S21, S24 | `19cdee579` feat(files): add the search row, line gutter and preview position |
| T11 + T12 | S22, S23, S26 | `8dbf6c7d7` feat(files): narrow the picker, smooth the editor handoff and show the listed path |

Delivery still follows `gentle-ai-chained-pr`, a tracker PR plus one chained PR per unit, and nothing is pushed without the human's decision.

## Verification evidence

Baseline parity, unit stage (`node --experimental-strip-types --test tests/*.test.ts`), measured by diffing the failing test names of both trees:

| Tree | tests | pass | fail |
| --- | --- | --- | --- |
| `main` @ `29b57a414` | 5261 | 4952 | 245 |
| `feat/file-picker` after T4/T6 | 5317 | 5008 | 245 |

The 246 failing test names are identical in both trees, so the branch adds 56 passing tests and no new failure. The pre-existing failures come from this checkout having no complete `node_modules` (for example `tests/command-palette.test.ts` cannot load `pi-coding-agent/dist/modes/interactive/theme/theme.js`), not from the diff. A clean `pnpm install` plus `pnpm test` and `pnpm typecheck` is still owed before delivery is claimed.

L10 (parent, verification findings): an independent verifier reviewed the six committed units against the sources and found five defects worth fixing before delivery. T8 fixes them: (1) `@` must be relative to the session cwd, not the repository root, or a session started in a subdirectory names the wrong file; (2) `finish()` needs `try/finally` so a throwing `onInsert`/`onOpen` cannot leave a dead open overlay; (3) the scope list must use the same roots source and filters `/changes` uses, and must map a rejected branch lookup to `unknown` instead of folding it into `detached`; (4) `ctrl+c` is undocumented, the `alt+p` default is reserved by Pi on Windows/WSL (`app.model.cycleBackward`) and needs that caveat, and `/gentle:files` is missing from the palette catalog; (5) the extension wiring has no regression tests, which is the item-6 risk, so T8 adds them now that `node_modules` is available via a symlink to a sibling worktree. Verified as passing by the verifier and not defects: overlay teardown order, paste-then-close ordering (the forced full repaint paints the paste), the editor handoff, and every bounding/failure path in the index and preview reader.

T9/T10/T11/T12 round, recorded by the parent:

- Focused integrated set, after the T12 wiring: `node --experimental-strip-types --test tests/file-picker-view.test.ts tests/file-scope-view.test.ts tests/shell-changes-view.test.ts tests/gentle-shell.test.ts tests/keymaps.test.ts tests/command-palette.test.ts` — 512 tests, 512 pass, 0 fail, exit 0. The same command before the T12 wiring: 511 tests, 511 pass, 0 fail.
- `node scripts/check-types.mjs`: `0 recorded diagnostic(s), no regressions`, exit 0.
- `node scripts/check-provider-contract.mjs`: `contract 1.4.0, 10 bundle entries, 2 generated baselines`, exit 0.
- `command-palette` and `keymaps` pass on this checkout because a `node_modules` symlink to a sibling worktree exists, so the earlier note that they cannot load Pi's theme module no longer applies to this round.
- The full unit stage (`node --experimental-strip-types --test tests/*.test.ts`) was NOT re-run this round. The baseline-parity evidence above is unchanged, and a clean `pnpm install` plus `pnpm test` and `pnpm typecheck` is still owed before delivery is claimed.

## Log

L1 (user, verbatim):

> es posible agregar a gentle shell un file picker, algo de este estilo [Image#1] pero al estil ocustomize gentle [Image#3] o sea, arrba titulo a la izquerda el listado de arhivos y derecha preview, todo clicleable y el prevbiew scroleable con scroll mouse o con keybindg (ctrl j/k + ctrl shift j/k adicional para compatibilidad linux), con abajo las keybindings. Con el search para busacr, diria que seria mal como el commands de gentle shell [Image#4] ahi directeamnte el searh esta siemrpre activo, las keybindig serian combinaciones para no chocar con search como ctrl j/k. Tambien podriamos poner abrir con editor como en /changes ,aqui con ctrl e. Y darle enter mandar el archivo al chat/ al input. Y le ponemos el atajo ctrl f para abrir el panel rapido, igal configurable en keymaps. Que te parece, es viable?
>
> /home/jona/dev/upstream/fzf.fish el file picker del ejemplo es ese, puedes investigarlo igual

L2 (user, verbatim):

> bien, implementalo en nuestro fork en un nuevo worktree desde main

L3 (user, verbatim):

> lo de enter me parece bien insertar y cerrar panel, como el de fzf funciona asi

L4 (parent, decisions):

- Exploration mapped the reusable infrastructure: overlay/card chrome in `lib/command-palette.ts` (`renderPaletteCard`), list+preview geometry and `ctrl+j/k` scroll in `lib/shell-changes-view.ts`, always-active filter in `CommandPalette.handleInput`, editor launch in `lib/external-editor.ts`, prompt insertion via `ctx.ui.pasteToEditor`, keymap registry in `lib/keymaps.ts`.
- `ctrl+k` is a reserved Pi editor keybinding, so a Gentle keymap on it is skipped; `ctrl+f`/`ctrl+e` are live Pi editor bindings and are therefore not used as the opener default (S9).
- In-panel keys do not pass through the keymap registry, so `ctrl+j/k` and `ctrl+shift+j/k` are free inside the panel and collide with nothing.
- Enter semantics confirmed by L3: insert and close, never send (S8).

L5 (user, verbatim):

> alt+p me parece bien

L6 (user, verbatim):

> igual sera configurable

L7 (parent, decisions): the default opener key is confirmed as `alt+p` (L5) and S9 already requires it to stay configurable in Keymaps and through its environment variable (L6); no spec change needed.

L8 (user, verbatim):

> [Image#5] la imagen es de otro de nvim pero me dio idea de implementar. La primera es que salgan los archivos modificados primero, si es un archivo nuevo creado sale new, si se actualizo sale upt y en ambos casos a su derecha sale hace cuanto tiempo, en s/h/d (igual esto se calcula al abrir no se recalcula/actualiza en vivo).
>
> igual ahi falta la keybundt de ctrl u yo creo para limpiar el search.
>
> Y con "tab" como keybindg select como en zft [Image#6] donde como vez los seleccionador los resalta y luego con enter manda todos los seleecionado (incluyendo al que le dio enter, enter lo agrega seleccionado y manda el focus, es la misma logica, aunque claro no se agrega seleecionado uno que ya esta, tienes zft para saber como funciona igual pero la logica es sencilla).
>
> Otro aspecto que le sumeria seria los worktrees como en changes [Image#7] , usa el session de worktree register que changes. Para que no cargue tanto siempre, al abrir file picker sale un selector primero donde sale main o wortrees, en orden de modificacion (el mas reciente modificado arriba primero), luego de seleecioarlo con enter ahi si se abre el file picker y carga/muestra los archvios de ese path de verdad con los archivos de ese path. Si no hay ningun worktree registrato directamente file picker abre del path actual claro.
>
> ademas al igual que zft los archivos que manda los manda con @ como por ejemplo "@Agents" pues el @ es como el path actual, asi lo toma pi y sabe que es el agents del path actual  o por ejemplo "@src/index.ks" @themes/Gentle.json  esos son otros ejemplos. Pero si manda el de un worktre es diferente, ahi el "@" no sirve pues es otra ruta, en ese caso debe mandar/pegar la ruta completa ~/dev/workte/index.js" por dar un ejemplo.

L9 (parent, decisions): L8 is a requirement change. Specs added: S12 (change state and age, computed once at open), S13 (`ctrl+u` in the footer), S14 (Tab multi-select, fzf semantics), S15 (worktree scope selector first), S16 (`@`-relative for the current path, absolute for a worktree), S17 (space-separated multi-insertion). S8 was refined to defer to S14/S16/S17. T4 (index) is additive on purpose: `listRepositoryFiles` keeps its shape so T2's in-flight work does not break, and the new entry-level listing lands beside it for T5 to consume.

L13 (user, verbatim):

> Reanudá el file picker en el worktree /home/jona/dev/projects/gentle-shell-worktrees/file-picker, rama feat/file-picker. Leé odd/tasks/file-picker.md y revisá el diff sin descartar los cambios existentes. Falta conectar scope.root al encabezado del picker, verificar que se vea la ruta del scope elegido y correr las pruebas integradas de esta ronda. Después revisá y commiteá los cambios si las verificaciones lo permiten. No hagas push.

> Falta conectar scope.root al encabezado del picker, verificar que se vea la ruta del scope elegido

L14 (parent, verification evidence and delivery state): the round's writer route failed twice with `provider_unavailable` and produced no edits before a third attempt landed, so no other fallback writer was usable. This round's `Risk:` classification is none — no irreversible data, security, contract, concurrency or delivery surface, and every changed behaviour is covered by the focused set — so no independent verifier was run; the verifier admission requires a declared high-risk item and none exists. `odd/` is matched by the machine-global gitignore (`~/.config/git/.gitignore:236`) and this document was never tracked while the repository tracks the other `odd/tasks/*.md` files, so it is force-added for this round's closing commit. Nothing was pushed.
