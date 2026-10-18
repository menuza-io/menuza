# Decisions

This directory contains all the decisions we've made for this starter template
and serves as a record for whenever we wonder why certain decisions were made.

Decisions in here are never final. But these documents should serve as a good
way for someone to come up to speed on why certain decisions were made.

Recent additions:

- [048 - Reservations data residency](./048-reservations-data-residency.md) —
  why reservations and guest data live in the regional tenant database, how
  guests and operators reach it browser-direct, and where payments and webhooks
  cross planes.
- [047 - Staffing data residency and identity](./047-staffing-data-residency.md)
  — why staff, pay, punch, schedule and applicant data lives in the regional
  tenant database, why staff are not members, and which flags gate the module.
- [046 - Staging hostnames and cookies](./046-staging-hostnames-and-cookies.md)
  — flat `app-staging.{apex}` URLs for free Universal SSL and staging-suffixed
  operator cookie names.
- [045 - Tenant data residency](./045-tenant-data-residency.md) — why customer
  PII is on a regional tenant-api, why the browser calls it directly, and why
  changing region deletes tenant data.
