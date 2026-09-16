---
name: project-forms
description:
  Guide Zod and Conform forms, server validation, accessible errors, uploads,
  honeypots, and public tenant forms in this project.
---

# Project forms

## When to use this skill

Use this skill when adding or changing operator forms, route actions, client
validation, file uploads, public website form blocks, or form error handling.

## Standard form shape

Use Conform for form state and Zod for the canonical schema. Share schemas only
when the server and client genuinely have the same contract; server validation
always remains authoritative.

```typescript
import { parseWithZod } from '@conform-to/zod'
import { z } from 'zod'

const NoteSchema = z.object({
	title: z.string().trim().min(1).max(200),
	content: z.string().trim().max(100_000),
})

export async function action({ request }: Route.ActionArgs) {
	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: NoteSchema })

	if (submission.status !== 'success') {
		return Response.json({ result: submission.reply() }, { status: 400 })
	}

	// Authenticate, authorize, and perform the mutation with validated values.
	return Response.json({ ok: true })
}
```

Follow the existing helpers in `apps/app/app/components/forms.tsx` and the
nearby route patterns for `useForm`, `getFormProps`, `getInputProps`, field
errors, and `lastResult`. Prefer a progressive-enhancement
`<Form method="post">` or `useFetcher` flow over a client-only submission when a
route action is the natural owner of the mutation.

## Validation and errors

- Parse `FormData` before database, filesystem, email, payment, or external API
  work.
- Normalize only where the product contract allows it; do not silently change
  phone, email, slug, or user-entered content in a way the user cannot see.
- Return field-level errors through Conform and form-level failures through the
  shared error components. Use messages that tell the user how to recover.
- Treat client validation as feedback, never as authorization or security.
- Use `@repo/validation` and shared package schemas when an existing contract
  already covers the field.

## Authentication and authorization order

For a protected action, fail fast in this order: authenticate, resolve the
organization, verify the relevant permission, parse and validate input, then
mutate. The exact ordering can vary when a public form must validate a honeypot
first, but no untrusted value should reach a side effect before all required
security checks pass.

## Public tenant forms

Published forms on `apps/sites` submit directly from the browser to the matching
regional tenant-api. Keep customer responses in regional tenant SQLite. Do not
proxy submissions through Sites SSR or store them in the US control plane.

For the complete Astro host/locale/CSP/public-cache lifecycle, read
[project-public-sites](../project-public-sites/SKILL.md). For changes to the
regional API, read [project-tenant-data](../project-tenant-data/SKILL.md).

The tenant-api form endpoint enforces published-only access, Origin/org
resolution, field/length/email/choice validation, rate limits, and retention.
When configured, Sites renders Turnstile and tenant-api verifies the token with
`TURNSTILE_SECRET_KEY`; the honeypot remains a defense layer. Follow the public
form implementation in `apps/sites` and `apps/tenant-api/src/routes/forms.ts`.

## Files and rich content

- Use the existing storage/upload components and validate content type, size,
  image metadata, and ownership server-side.
- Never render submitted HTML directly. Use the project sanitization helper
  before any intentionally trusted HTML rendering.
- For arrays or fieldsets, preserve stable item IDs and validate the complete
  submitted structure with Zod.

## References

- [Security docs](../../security.md)
- [Tenant data residency](../../tenant-data-residency.md)
- [Public forms](../../decisions/033-honeypot.md)
- [`forms.tsx`](../../../apps/app/app/components/forms.tsx)
