import { i18n } from '@lingui/core'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	type MenuCategory,
	type MenuItem,
	type MenuOption,
	type MenuPayload,
	type ModifierGroup,
} from './types.ts'

/**
 * Menu text in the till's language. The published menu carries translatable
 * names as JSON maps (`{"en":"Starters","ar":"مقبلات"}`), which the website
 * resolves per visitor; a plain string passes through unchanged. Falls back to
 * the restaurant's default language, then to any language there is.
 */
export function menuText(
	value: string | null | undefined,
	locale: string = i18n.locale || 'en',
	defaultLocale = 'en',
): string {
	return getLocalizedMenuValue(value, locale, defaultLocale)
}

/** The whole published menu with every name and description in one language. */
export function localizeMenu(menu: MenuPayload, locale: string): MenuPayload {
	const fallback = menu.organization.defaultLocale || 'en'
	const text = (value: string) => menuText(value, locale, fallback)
	const optional = (value: string | null) =>
		value === null ? null : menuText(value, locale, fallback) || null
	const group = (g: ModifierGroup): ModifierGroup => ({
		...g,
		name: text(g.name),
		options: g.options.map((o): MenuOption => ({
			...o,
			displayName: text(o.displayName),
			...(o.nestedModifierGroups
				? { nestedModifierGroups: o.nestedModifierGroups.map(group) }
				: {}),
		})),
	})
	const item = (i: MenuItem): MenuItem => ({
		...i,
		displayName: text(i.displayName),
		description: optional(i.description),
		variations: {
			...i.variations,
			groups: i.variations.groups.map((g) => ({
				...g,
				name: text(g.name),
				values: g.values.map((v) => ({ ...v, name: text(v.name) })),
			})),
		},
		modifierGroups: i.modifierGroups.map(group),
	})
	const category = (c: MenuCategory): MenuCategory => ({
		...c,
		displayName: text(c.displayName),
		items: c.items.map(item),
		...(c.subcategories
			? { subcategories: c.subcategories.map(category) }
			: {}),
	})
	return {
		...menu,
		locations: menu.locations.map((l) => ({ ...l, name: text(l.name) })),
		menus: menu.menus.map((m) => ({
			...m,
			displayName: text(m.displayName),
			categories: m.categories.map(category),
		})),
	}
}
