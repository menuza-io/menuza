import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'

// Built-in organization roles (`org_role_*` ids) are stored with lowercase names
// and English descriptions (see packages/database/setup-roles.ts); show them
// translated.
const SYSTEM_ROLES = {
	admin: {
		name: msg`Admin`,
		description: msg`Full access to organization settings and members`,
	},
	member: {
		name: msg`Member`,
		description: msg`Standard organization member with note access`,
	},
	viewer: {
		name: msg`Viewer`,
		description: msg`Read-only access to organization notes`,
	},
	guest: {
		name: msg`Guest`,
		description: msg`Limited access for temporary collaborators`,
	},
} as const

type RoleLike = { id: string; name: string; description?: string | null }

const BUILT_IN_ROLE_PREFIX = 'org_role_'

// Match built-ins by their fixed id, not by name: a custom role may also be
// called "Admin", and must keep its own description.
function systemRole(role: RoleLike) {
	if (!role.id.startsWith(BUILT_IN_ROLE_PREFIX)) return null
	const key = role.id.slice(BUILT_IN_ROLE_PREFIX.length)
	return Object.hasOwn(SYSTEM_ROLES, key)
		? SYSTEM_ROLES[key as keyof typeof SYSTEM_ROLES]
		: null
}

/** Display labels for organization roles: built-ins translated, custom roles capitalized. */
export function useRoleLabels() {
	const { _ } = useLingui()
	return {
		roleName(role: RoleLike) {
			const system = systemRole(role)
			if (system) return _(system.name)
			return role.name.charAt(0).toUpperCase() + role.name.slice(1)
		},
		roleDescription(role: RoleLike) {
			const system = systemRole(role)
			return system ? _(system.description) : (role.description ?? null)
		},
	}
}
