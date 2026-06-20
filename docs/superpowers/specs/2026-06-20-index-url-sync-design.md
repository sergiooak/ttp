# Index URL Sync Design

## Context

`render.html` already defines the bot-facing query parameter contract for TTP rendering. `index.html` is the human preview/editor and currently keeps its control state only in DOM inputs. This makes preview states hard to bookmark or share.

The feature will add two-way URL synchronization to `index.html` only. It will not change `render.html` or the render contract.

## Goals

- Hydrate the editor controls from query parameters on page load.
- Keep the browser URL synchronized with current editor input.
- Use the exact same parameter names as `render.html`: `text`, `topText`, `bottomText`, `mode`, `color`, and `strokeColor`.
- Keep URLs canonical by omitting values that match defaults.
- Avoid adding every keystroke to browser history.

## Non-Goals

- No new build step, framework, router, or shared state library.
- No changes to bot integration behavior in `render.html`.
- No new visual controls.
- No persistence outside the URL.

## URL Contract

`index.html` will read and write these parameters:

| Param | Default | Usage |
| --- | --- | --- |
| `text` | `olha a velocidade disso` | Main text for every mode except `both`. |
| `topText` | empty | Top text when `mode=both`. |
| `bottomText` | empty | Bottom text when `mode=both`. |
| `mode` | `center` | One of `center`, `top`, `bottom`, `both`, `split`. |
| `color` | `#ffffff` | Fill color. |
| `strokeColor` | `#000000` | Outline color. |

Invalid or unsupported `mode` values will fall back to `center`, matching the renderer's behavior.

## Behavior

On initial load:

1. Build `URLSearchParams` from `location.search`.
2. Apply valid parameter values to the existing form controls.
3. Render once using the existing `update()` flow.
4. Normalize the URL with the canonical parameter set.

During editing:

1. Existing input listeners continue to call `update()`.
2. Each input change schedules a debounced URL write.
3. URL writes use `history.replaceState`, not `pushState`, so the Back button is not polluted by text edits.

For `mode=both`, the URL owns `topText` and `bottomText`. The main textarea acts as the top-text control, so its value is serialized as `topText`, and `text` is removed from the URL.

For all other modes, the URL owns `text`. `topText` and `bottomText` are removed from the URL.

Unrelated query parameters will be preserved, so embedding or future parameters are not lost by the editor.

## Canonicalization

The URL writer will omit:

- `mode=center`
- `color=#ffffff`
- `strokeColor=#000000`
- empty `bottomText`
- empty `topText`
- empty `text`
- `text=olha a velocidade disso`
- `text` while `mode=both`
- `topText` and `bottomText` while `mode` is not `both`

If all owned parameters are omitted and no unrelated parameters remain, the URL becomes the bare `index.html` path without a trailing `?`.

## Implementation Shape

Keep the implementation local to the existing module script in `index.html`:

- `DEFAULTS`: constants for default text, mode, and colors.
- `readStateFromUrl(params)`: returns normalized state from query params.
- `applyStateToControls(state)`: writes state into existing inputs.
- `stateFromControls()`: reads current controls into the render/query state shape.
- `writeStateToUrl(state)`: serializes canonical params and calls `history.replaceState`.
- `scheduleUrlSync()`: debounces URL writes from input events.

This avoids introducing a helper module before there is real reuse pressure.

## Error Handling

- Unknown modes are ignored and normalized to `center`.
- Missing parameters use current defaults.
- Color values are passed through if present. Browser color inputs will coerce invalid assigned values back to their default value, and the canonical writer will serialize the control's resulting value.

## Testing

Manual browser checks are enough for this static preview change:

1. Open `index.html?text=hello&mode=bottom&color=%23ffcc00`.
2. Confirm controls hydrate and the preview renders.
3. Edit text and confirm the URL changes without adding history entries.
4. Switch to `both` and confirm `text` is removed while `topText` and `bottomText` are used.
5. Switch back to `center` and confirm `topText` and `bottomText` are removed.
6. Reset controls to defaults and confirm owned params disappear from the URL.

## References

- MDN `URLSearchParams`: https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams
- MDN `history.replaceState`: https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState
- MDN History API guide: https://developer.mozilla.org/en-US/docs/Web/API/History_API/Working_with_the_History_API
- Chrome Developers `URLSearchParams`: https://developer.chrome.com/blog/urlsearchparams
