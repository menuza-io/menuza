---
name: project-permissions
description:
  Guide system and organization RBAC, server authorization, custom roles, and
  permission-aware UI in this project.
---

# Project permissions

## When to use this skill

Use this skill when protecting loaders/actions, adding a permission, changing
organization roles, building permission-aware UI, or reviewing tenant access.

## Two permission contexts

Do not mix these contexts:

- **System permissions** apply to platform/admin features. Use the constants in
  `packages/auth/src/system-permissions.ts` and shared checks from `@repo/auth`.
- **Organization permissions** apply to a user’s membership in one organization.
  Use `ORG_PERMISSIONS` and the organization-aware helpers from `@repo/auth` or
  `apps/app/app/utils/organization/permissions.server.ts`.

Permission strings follow `action:entity:access`, for example
`read:website:any`, `update:settings:any`, or `create:note:own`. The parser is
shared; do not invent a second permission grammar.

## Authorize on the server

```typescript
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

export async function action({ request, params }: Route.ActionArgs) {
	const organizationId = await resolveOrganizationId(params.orgSlug)
	await requireUserWithOrganizationPermission(
		request,
		organizationId,
		'update:website:any',
	)

	// Validate input, then mutate only this organization’s data.
}
```

Use `requireUserId`/`authorize` for authentication and system permissions, and
the organization wrapper for organization membership plus active-role checks.
Check the permission before the mutation and scope every database query to the
authorized organization. A hidden button or client permission check is never a
security boundary.

Return the project’s consistent 401/403 behavior. Avoid leaking whether an
unauthorized user can access a record; use the existing route patterns for
not-found versus forbidden responses.

## UI checks

Use `use-organization-permissions.ts`, the permission guard, and loader-provided
permission data to hide or disable controls when helpful. This improves the
experience, but the corresponding loader/action must repeat the server check. Do
not fetch all permissions into a browser if a smaller capability set is enough.

## Roles and custom organization roles

Built-in organization roles are seeded in `packages/database/setup-roles.ts`.
System roles are managed by Admin; organization roles are managed in the
organization settings UI. Custom tenant-owned roles may receive only the
allow-listed permission IDs from
`apps/app/app/utils/organization/tenant-role-permissions.ts`.

When adding a feature:

1. Choose the correct context and ownership scope.
2. Add the permission constant/seed data and migration if needed.
3. Grant it to the intended built-in roles.
4. Add server checks to every read and mutation path.
5. Add UI gating and tests for allowed, denied, inactive, and cross-org cases.

Never grant `any` access when `own`/organization-scoped access is sufficient,
and never trust an organization ID supplied by the browser without resolving it
against the signed-in user’s membership.

## References

- [Permissions docs](../../permissions.md)
- [RBAC ADR](../../decisions/028-permissions-rbac.md)
- [Authorization helpers](../../../packages/auth/src/authorize.server.ts)
