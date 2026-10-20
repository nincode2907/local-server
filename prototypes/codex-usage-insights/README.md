# Codex Usage Insights prototype

Open `index.html` in a browser. This prototype is isolated from the production dashboard and uses no API, database, model call, or build step.

## Architecture

- `index.html` holds the page shell, filters, KPI region, chart cards, and detail tables.
- `style.css` reuses the dashboard's light palette, Avenir/monospace typography, card borders, and responsive spacing; a theme toggle enables dark mode.
- `app.js` creates deterministic synthetic usage events, aggregates them by event time in UTC+7, and renders SVG charts, the heatmap, distribution views, and summary tables.
- `screenshots/` contains the four desktop range states plus mobile and dark mobile captures.
- Every render runs aggregate consistency assertions for input/cache splits and project/model/distribution totals. The results are available in `window.__usageInsightAssertions` for browser review.
- `INTEGRATION-READINESS.md` maps the prototype to the current native usage API and lists the fields needed before an adapter can reproduce every view.

The synthetic rate table exists only to demonstrate API-equivalent cost calculations. It does not represent actual API prices or ChatGPT subscription usage. Events without usage remain unknown and are excluded from token and cost totals.

## Interactions

Range, project, model, source, metric, and theme controls are active. The yesterday distribution switches between project and model. Cached input can be hidden in token mode. Chart marks and table rows expose details and highlight the selected project/model. Filters can also reach empty states.

## Future native usage integration

The prototype has not been integrated into production. Before migration, preserve the production dashboard's original eight KPI metrics and detailed session information; this four KPI prototype is an additional insights surface. See `INTEGRATION-READINESS.md` for the existing API mapping and missing aggregation fields.

## Screenshots

- Desktop: [Hôm nay](screenshots/today-desktop.png), [Hôm qua](screenshots/yesterday-desktop.png), [7 ngày](screenshots/7-days-desktop.png), [30 ngày](screenshots/30-days-desktop.png)
- Mobile 7 ngày: [Light](screenshots/7-days-mobile.png), [Dark](screenshots/7-days-mobile-dark.png)
