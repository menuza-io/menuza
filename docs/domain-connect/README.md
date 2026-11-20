# Domain Connect templates

Templates for "Connect automatically" (#313, `docs/custom-domains.md`). They are
the records Menuza asks a DNS host to set, as Domain Connect templates. They
contain routing records only: the flow never adds, replaces or removes an MX,
SPF, DKIM or DMARC record, and the App refuses to build a plan that would
(`changeTouchesMail` in `packages/common/src/domain-zone.ts`).

Before the feature can be turned on, the templates must be submitted to the
Domain Connect templates repository
(<https://github.com/Domain-Connect/Templates>) so providers load them, and
`DOMAIN_CONNECT_PROVIDER_ID` must be set to the provider id used here
(`menuza.io`; change both together). Until then discovery answers "not
supported" and the screen offers the written steps only.
