# pulse-status documentation

pulse-status is the status page of pulse. It is a small web server that reads pulse-api and shows every check with its state, the open incidents and the upcoming maintenance.

- [install.md](install.md): run it with Bun or Docker.
- [configuration.md](configuration.md): every environment variable.
- [theming.md](theming.md): theme file, white-label name and logo, palette rules, a working example, and the `/api/*` proxy.
- [operation.md](operation.md): what the page shows, how it refreshes, the Atom feed and badges, and how to run it.
- [troubleshooting.md](troubleshooting.md): startup errors and a page that shows no or stale data.
- [development.md](development.md): local run, tests, lint and CI.

Related pages in other repositories:

- [pulse-api configuration](https://github.com/lorenzh/pulse-api/blob/main/docs/configuration.md), the service that this page reads.
- [Single probe and quorum rule](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents).
