# Permissions

The Epic Stack's Permissions model takes after
[Role-Based Access Control (RBAC)](https://auth0.com/intro-to-iam/what-is-role-based-access-control-rbac).
Each user has a set of roles, and each role has a set of permissions. A user's
permissions are the union of the permissions of all their roles (with the more
permissive permission taking precedence).

The default development seed creates fine-grained permissions that include
`create`, `read`, `update`, and `delete` permissions for `user` and `note` with
the access of `own` and `any`. The default seed also creates `user` and `admin`
roles with the sensible permissions for those roles.

You can combine these permissions in different ways to support different roles
for different personas of users of your application.

The Epic Stack comes with built-in utilities for working with these permissions.
Here are some examples to give you an idea:

```ts
// server-side only utilities
const userCanDeleteAnyUser = await requireUserWithPermission(
	request,
	'delete:user:any',
)
const userIsAdmin = await requireUserWithRole(request, 'admin')
```

```ts
// UI utilities
const user = useUser()
const userCanCreateTheirOwnNotes = userHasPermission(user, 'create:note:own')
const userIsUser = userHasRole(user, 'user')
```

There is currently no UI for managing permissions, but you can use Drizzle
Studio for establishing these.

## Organization permissions

Organization roles use a separate permission context
(`Permission.context = 'organization'`) and are checked with
`requireUserWithOrganizationPermission` (from `@repo/auth`, or the request-aware
wrapper in `apps/app/app/utils/organization/permissions.server.ts`).

Built-in organization roles are seeded in `packages/database/setup-roles.ts`:

- `org_role_admin` — every organization permission
- `org_role_member` — notes, members, and read-only marketing
- `org_role_viewer` — read-only notes, members, and marketing
- `org_role_guest` — no permissions

Product areas are gated with these permissions:

| Area                     | Permissions                               |
| ------------------------ | ----------------------------------------- |
| Notes                    | `create/read/update/delete:note:own\|org` |
| Members                  | `read/create/update/delete:member:any`    |
| Organization settings    | `read/update:settings:any`                |
| Website pages/forms/etc. | `read/update:website:any`                 |
| Website announcements    | `read/update:announcement:any`            |
| Marketing broadcasts     | `read/update:campaign:any`                |
| Marketing automations    | `read/update:automation:any`              |

Organization admins can create custom roles from `/{orgSlug}/settings/roles`;
only the permission IDs allow-listed in
`apps/app/app/utils/organization/tenant-role-permissions.ts` may be assigned to
a tenant-owned role.

## Platform (system) permissions

The admin app checks platform-level permissions
(`Permission.context = 'system'`) with `requireUserWithPermission` /
`requireAnyUserWithPermission` from `@repo/auth`, using the strings in
`packages/auth/src/system-permissions.ts`:

| Area                 | Permissions                           |
| -------------------- | ------------------------------------- |
| Platform broadcasts  | `read/update:platform_campaign:any`   |
| Platform automations | `read/update:platform_automation:any` |

The built-in `admin` system role is granted every system permission by the
`0013_website_announcement_marketing_permissions` migration and by
`setupRoles()`. System roles and their permissions are managed from the admin
app's Roles page (`/roles`), and organization roles (shared platform roles) are
managed from the same page.

## Seeding the production database

Check [the deployment docs](./deployment.md) for instructions on how to seed the
production database with the roles you want.
