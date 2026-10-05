# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds documentation-site truth.

## Platform

web

## Users

Developers working with the template (setup, architecture, deployment, security)
and operators configuring SSO and integrations. Read-only consumption; there are
no accounts.

## Product Purpose

The hosted documentation site: getting-started and quickstart guides, the
application catalog, authentication (password, OAuth, SSO), database, styling,
deployment, and markdown conventions, security guides (secure coding, data
protection, incident response, compliance), integration guides (workspace tools), and an
API reference.

## Operating Context

Mintlify MDX site; navigation is fully declared in `docs.json`; deployed by the
docs platform's GitHub integration on push; `npm run docs:dev` (port 3004).
Pages are MDX with the platform's components (cards, accordions, code groups,
notes and tips); link integrity is linted.

## Capabilities and Constraints

Content-only: no application logic, no auth. Keep navigation declarative in
`docs.json` rather than as sidebars inside pages.

Open items: the navbar and footer still point at the docs platform's starter
defaults, and the API reference still shows the starter's sample endpoints; both
need product ownership before launch.
