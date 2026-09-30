/**
 * Provider payload codecs. Each codec narrows an external JSON payload into the
 * canonical `RemoteItem` shape (and back). Ported from the Mise reference
 * project (`lib/pos/wire.ts`), trimmed to the five supported platforms.
 */

import { ALL_DAY, type RemoteItem, type RemoteMenu } from './types.ts'

// External payloads are untyped JSON; each codec narrows what it needs.
type Wire = any
export type Decoded = { items: RemoteItem[]; menus: RemoteMenu[] }

const everyDay = [0, 1, 2, 3, 4, 5, 6]
const uberDays = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
]
const shortDays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const toastDays = [
	'MONDAY',
	'TUESDAY',
	'WEDNESDAY',
	'THURSDAY',
	'FRIDAY',
	'SATURDAY',
	'SUNDAY',
]
const dayIndex = (codes: string[], value: string) =>
	codes.indexOf(String(value).toUpperCase())
const toCents = (dollars: number) => Math.round(Number(dollars) * 100)
const toDollars = (cents: number) => cents / 100

export const slug = (value: string) =>
	value
		.replace(/[^a-z0-9]+/gi, '_')
		.replace(/^_|_$/g, '')
		.toUpperCase()

// Groups items into the menus they are served on, then into categories, as
// delivery menus require.
function layout(items: RemoteItem[], menus: RemoteMenu[]) {
	const table = menus.filter((menu) => menu.name !== ALL_DAY)
	for (const name of new Set(items.flatMap((item) => item.menus))) {
		if (!table.some((menu) => menu.name === name)) {
			table.push({ name, days: everyDay, start: '00:00', end: '23:59' })
		}
	}
	if (items.some((item) => !item.menus.length)) {
		table.unshift({
			name: ALL_DAY,
			days: everyDay,
			start: '00:00',
			end: '23:59',
		})
	}
	return table.map((menu) => {
		const served = items.filter((item) =>
			menu.name === ALL_DAY
				? !item.menus.length
				: item.menus.includes(menu.name),
		)
		const categories = [...new Set(served.map((item) => item.category))].map(
			(name) => ({
				name,
				items: served.filter((item) => item.category === name),
			}),
		)
		return { menu, categories }
	})
}
function assemble(
	menus: RemoteMenu[],
	rows: { menu: string; category: string; item: RemoteItem }[],
): Decoded {
	const byId = new Map<string, RemoteItem>()
	for (const row of rows) {
		const item = byId.get(row.item.id) ?? {
			...row.item,
			category: row.category,
			menus: [],
		}
		if (row.menu !== ALL_DAY && !item.menus.includes(row.menu)) {
			item.menus.push(row.menu)
		}
		byId.set(item.id, item)
	}
	return {
		items: [...byId.values()].map((item) => ({
			...item,
			menus: item.menus.sort(),
		})),
		menus: menus.filter((menu) => menu.name !== ALL_DAY),
	}
}
const base = (id: string): RemoteItem => ({
	id,
	name: '',
	description: '',
	category: 'Uncategorized',
	price: 0,
	imageUrl: null,
	available: true,
	modifierGroups: [],
	variations: [],
	menus: [],
	allergens: [],
	alcohol: false,
	taxRate: null,
	version: 1,
})
const readSizes = (value: Wire): RemoteItem['variations'] =>
	Array.isArray(value)
		? (value as { name?: unknown; price?: unknown }[])
				.map((size) => ({
					name: String(size.name),
					price: Number(size.price),
				}))
				.filter((size) => size.name && Number.isSafeInteger(size.price))
		: []

/* ---------------- Clover: /v3/merchants/{mId}/items?expand=categories,modifierGroups,taxRates ---------------- */
export const cloverWire = {
	encode(item: RemoteItem): Wire {
		return {
			id: item.id,
			name: item.name,
			price: item.price,
			available: item.available,
			alcoholic: Boolean(item.alcohol),
			hidden: false,
			modifiedTime: item.version,
			variations: item.variations ?? [],
			categories: {
				elements: [{ id: `CAT_${slug(item.category)}`, name: item.category }],
			},
			modifierGroups: {
				elements: item.modifierGroups.map((group) => ({
					id: `MG_${slug(group.name)}`,
					name: group.name,
					minRequired: group.min,
					maxAllowed: group.max,
					modifiers: {
						elements: group.options.map((option) => ({
							id: `MOD_${slug(group.name)}_${slug(option.name)}`,
							name: option.name,
							price: option.price,
							available: option.available !== false,
						})),
					},
				})),
			},
			// Clover stores tax rates in hundred-thousandths of a percent (8.875% -> 887500).
			taxRates: {
				elements:
					item.taxRate === null
						? []
						: [
								{
									id: `TAX_${slug(String(item.taxRate))}`,
									name: `Sales tax ${item.taxRate}%`,
									rate: Math.round(item.taxRate * 100000),
								},
							],
			},
		}
	},
	decode(element: Wire): RemoteItem {
		const tax = element.taxRates?.elements?.[0]
		return {
			...base(String(element.id)),
			name: String(element.name),
			price: Number(element.price),
			available: element.available !== false,
			variations: readSizes(element.variations),
			category: element.categories?.elements?.[0]?.name ?? 'Uncategorized',
			modifierGroups: (element.modifierGroups?.elements ?? []).map(
				(group: Wire) => {
					const optionCount = group.modifiers?.elements?.length ?? 0
					const maxAllowed = Number(group.maxAllowed ?? 0)
					return {
						id: group.id ? String(group.id) : undefined,
						name: String(group.name ?? 'Modifiers'),
						min: Number(group.minRequired ?? 0),
						max: maxAllowed > 0 ? maxAllowed : Math.max(optionCount, 1),
						options: (group.modifiers?.elements ?? []).map((option: Wire) => ({
							id: option.id ? String(option.id) : undefined,
							name: String(option.name ?? 'Option'),
							price: Number(option.price ?? 0),
							available: option.available !== false,
						})),
					}
				},
			),
			taxRate: tax ? Number(tax.rate) / 100000 : null,
			alcohol: Boolean(element.alcoholic),
			version: Number(element.modifiedTime ?? 1),
		}
	},
}

/* ---------------- Square: Catalog API objects (ITEM, CATEGORY, MODIFIER_LIST, TAX, IMAGE) ---------------- */
export const squareWire = {
	encode(items: RemoteItem[], currency: string, locationId: string): Wire[] {
		const related = new Map<string, Wire>()
		const itemObjects = items.map((item) => {
			const categoryId = `SQ_CAT_${slug(item.category)}`
			related.set(categoryId, {
				type: 'CATEGORY',
				id: categoryId,
				version: 1,
				category_data: { name: item.category },
			})
			const listIds = item.modifierGroups.map((group) => {
				const id = `SQ_ML_${slug(group.name)}`
				related.set(id, {
					type: 'MODIFIER_LIST',
					id,
					version: 1,
					modifier_list_data: {
						name: group.name,
						selection_type: group.max === 1 ? 'SINGLE' : 'MULTIPLE',
						modifiers: group.options.map((option) => ({
							type: 'MODIFIER',
							id: `${id}_${slug(option.name)}`,
							modifier_data: {
								name: option.name,
								price_money: { amount: option.price, currency },
								hidden_online: option.available === false,
							},
						})),
					},
				})
				return {
					modifier_list_id: id,
					min_selected_modifiers: group.min,
					max_selected_modifiers: group.max,
				}
			})
			const taxIds =
				item.taxRate === null ? [] : [`SQ_TAX_${slug(String(item.taxRate))}`]
			if (item.taxRate !== null) {
				related.set(taxIds[0]!, {
					type: 'TAX',
					id: taxIds[0],
					version: 1,
					tax_data: { name: 'Sales tax', percentage: String(item.taxRate) },
				})
			}
			const imageIds = item.imageUrl ? [`SQ_IMG_${slug(item.id)}`] : []
			if (item.imageUrl) {
				related.set(imageIds[0]!, {
					type: 'IMAGE',
					id: imageIds[0],
					version: 1,
					image_data: { url: item.imageUrl },
				})
			}
			return {
				type: 'ITEM',
				id: item.id,
				version: item.version,
				item_data: {
					name: item.name,
					description: item.description,
					is_alcoholic: Boolean(item.alcohol),
					categories: [{ id: categoryId }],
					image_ids: imageIds,
					tax_ids: taxIds,
					modifier_list_info: listIds,
					food_and_beverage_details: {
						dietary_preferences: item.allergens.map((tag) => ({
							type: 'STANDARD',
							standard_name: tag.toUpperCase(),
						})),
					},
					variations: (item.variations?.length
						? item.variations
						: [{ name: 'Regular', price: item.price }]
					).map((variation, index) => ({
						type: 'ITEM_VARIATION',
						id:
							index === 0
								? (item.variationId ?? `#${item.id}_VAR`)
								: `#${item.id}_VAR_${index}`,
						version: item.version,
						item_variation_data: {
							item_id: item.id,
							name: variation.name,
							pricing_type: 'FIXED_PRICING',
							price_money: { amount: variation.price, currency },
							location_overrides: [
								{ location_id: locationId, sold_out: !item.available },
							],
						},
					})),
				},
			}
		})
		return [...related.values(), ...itemObjects]
	},
	decode(objects: Wire[], locationId: string): RemoteItem[] {
		const byId = new Map<string, Wire>(
			objects.map((object) => [object.id, object]),
		)
		return objects
			.filter((object) => object.type === 'ITEM' && !object.is_deleted)
			.map((object) => {
				const data = object.item_data
				const variation = data.variations?.[0]
				const override =
					variation?.item_variation_data?.location_overrides?.find(
						(entry: Wire) => entry.location_id === locationId,
					)
				const tax = byId.get(data.tax_ids?.[0])
				return {
					...base(String(object.id)),
					variationId: variation?.id,
					version: Number(object.version ?? 1),
					name: data.name,
					description: data.description ?? '',
					price: Number(
						variation?.item_variation_data?.price_money?.amount ?? 0,
					),
					available: !override?.sold_out,
					variations:
						(data.variations ?? []).length === 1 &&
						data.variations[0]?.item_variation_data?.name === 'Regular'
							? []
							: (data.variations ?? []).map((entry: Wire) => ({
									name: String(entry.item_variation_data?.name ?? 'Size'),
									price: Number(
										entry.item_variation_data?.price_money?.amount ?? 0,
									),
								})),
					category:
						byId.get(data.categories?.[0]?.id)?.category_data?.name ??
						'Uncategorized',
					imageUrl: byId.get(data.image_ids?.[0])?.image_data?.url ?? null,
					modifierGroups: (data.modifier_list_info ?? []).flatMap(
						(info: Wire) => {
							const list = byId.get(info.modifier_list_id)?.modifier_list_data
							return list
								? [
										{
											name: list.name,
											min: Number(info.min_selected_modifiers ?? 0),
											max: Number(
												info.max_selected_modifiers ?? list.modifiers.length,
											),
											options: list.modifiers.map((modifier: Wire) => ({
												name: modifier.modifier_data.name,
												price: Number(
													modifier.modifier_data.price_money?.amount ?? 0,
												),
												available: !modifier.modifier_data.hidden_online,
											})),
										},
									]
								: []
						},
					),
					allergens: (data.food_and_beverage_details?.dietary_preferences ?? [])
						.map((preference: Wire) =>
							String(preference.standard_name).toLowerCase(),
						)
						.sort(),
					taxRate: tax ? Number(tax.tax_data.percentage) : null,
					alcohol: Boolean(data.is_alcoholic),
				}
			})
	},
}

/* ---------------- Toast: /menus/v2/menus (read-only) plus /stock/v1/inventory ---------------- */
export const toastWire = {
	encode(
		items: RemoteItem[],
		menus: RemoteMenu[],
		restaurantGuid: string,
	): Wire {
		const groupRefs: Record<string, Wire> = {}
		const optionRefs: Record<string, Wire> = {}
		return {
			restaurantGuid,
			lastUpdated: new Date(0).toISOString(),
			menus: layout(items, menus).map(({ menu, categories }) => ({
				guid: `menu-${slug(menu.name).toLowerCase()}`,
				name: menu.name,
				availability:
					menu.name === ALL_DAY
						? { alwaysAvailable: true }
						: {
								alwaysAvailable: false,
								timeZone: menu.timezone ?? null,
								schedule: [
									{
										days: menu.days.map((day) => toastDays[day]),
										timeRanges: [{ start: menu.start, end: menu.end }],
									},
								],
							},
				menuGroups: categories.map((category) => ({
					guid: `group-${slug(category.name).toLowerCase()}`,
					name: category.name,
					menuItems: category.items.map((item) => ({
						guid: item.id,
						name: item.name,
						description: item.description,
						price: toDollars(item.price),
						image: item.imageUrl,
						isAlcoholic: Boolean(item.alcohol),
						allergens: item.allergens.map((name) => ({ name })),
						variations: item.variations ?? [],
						modifierGroupReferences: item.modifierGroups.map((group, g) => {
							const ref = `${item.id}:${g}`
							groupRefs[ref] = {
								referenceId: ref,
								name: group.name,
								minSelections: group.min,
								maxSelections: group.max,
								modifierOptionReferences: group.options.map((option, o) => {
									optionRefs[`${ref}:${o}`] = {
										referenceId: `${ref}:${o}`,
										name: option.name,
										price: toDollars(option.price),
										outOfStock: option.available === false,
									}
									return `${ref}:${o}`
								}),
							}
							return ref
						}),
					})),
				})),
			})),
			modifierGroupReferences: groupRefs,
			modifierOptionReferences: optionRefs,
		}
	},
	decode(payload: Wire, stock: Wire[]): Decoded {
		const outOfStock = new Set(
			stock
				.filter((entry) => entry.status === 'OUT_OF_STOCK')
				.map((entry) => entry.guid),
		)
		const menus: RemoteMenu[] = []
		const rows = (payload.menus ?? []).flatMap((menu: Wire) => {
			const schedule = menu.availability?.schedule?.[0]
			if (!menu.availability?.alwaysAvailable) {
				menus.push({
					name: menu.name,
					days: (schedule?.days ?? []).map((day: string) =>
						toastDays.indexOf(day),
					),
					start: schedule?.timeRanges?.[0]?.start ?? '00:00',
					end: schedule?.timeRanges?.[0]?.end ?? '23:59',
					...(menu.availability?.timeZone
						? { timezone: menu.availability.timeZone }
						: {}),
				})
			}
			const name = menu.availability?.alwaysAvailable ? ALL_DAY : menu.name
			return (menu.menuGroups ?? []).flatMap((group: Wire) =>
				(group.menuItems ?? []).map((entry: Wire) => ({
					menu: name,
					category: group.name,
					item: {
						...base(String(entry.guid)),
						name: entry.name,
						description: entry.description ?? '',
						price: toCents(entry.price),
						imageUrl: entry.image ?? null,
						available: !outOfStock.has(entry.guid),
						variations: readSizes(entry.variations),
						allergens: (entry.allergens ?? [])
							.map((allergen: Wire) => allergen.name)
							.sort(),
						alcohol: Boolean(entry.isAlcoholic),
						modifierGroups: (entry.modifierGroupReferences ?? []).map(
							(ref: string) => {
								const group = payload.modifierGroupReferences[ref]
								return {
									name: group.name,
									min: group.minSelections,
									max: group.maxSelections,
									options: group.modifierOptionReferences.map(
										(optionRef: string) => ({
											name: payload.modifierOptionReferences[optionRef].name,
											price: toCents(
												payload.modifierOptionReferences[optionRef].price,
											),
											available:
												!payload.modifierOptionReferences[optionRef].outOfStock,
										}),
									),
								}
							},
						),
					},
				})),
			)
		})
		return assemble(menus, rows)
	},
}

/* ---------------- Uber Eats: /v2/eats/stores/{id}/menus (full menu document) ---------------- */
const text = (value: string) => ({ translations: { en_us: value } })
const read = (value: Wire) => value?.translations?.en_us ?? ''
export const uberWire = {
	encode(items: RemoteItem[], menus: RemoteMenu[]): Wire {
		const categories: Wire[] = []
		const modifierGroups: Wire[] = []
		const optionItems: Wire[] = []
		const layoutMenus = layout(items, menus).map(
			({ menu, categories: groups }) => ({
				id: `MENU_${slug(menu.name)}`,
				title: text(menu.name),
				time_zone: menu.timezone ?? null,
				service_availability: menu.days.map((day) => ({
					day_of_week: uberDays[day],
					time_periods: [{ start_time: menu.start, end_time: menu.end }],
				})),
				category_ids: groups.map((group) => {
					const id = `${slug(menu.name)}__${slug(group.name)}`
					categories.push({
						id,
						title: text(group.name),
						entities: group.items.map((item) => ({
							id: item.id,
							type: 'ITEM',
						})),
					})
					return id
				}),
			}),
		)
		const topItems = items.map((item) => ({
			id: item.id,
			external_data: item.id,
			title: text(item.name),
			description: text(item.description),
			image_url: item.imageUrl,
			price_info: { price: item.price },
			variations: item.variations ?? [],
			suspension_info: item.available
				? null
				: { suspension: { suspend_until: 0, reason: 'Sold out' } },
			modifier_group_ids: {
				ids: item.modifierGroups.map((group) => {
					const id = `${item.id}__MG_${slug(group.name)}`
					modifierGroups.push({
						id,
						title: text(group.name),
						quantity_info: {
							quantity: { min_permitted: group.min, max_permitted: group.max },
						},
						modifier_options: group.options.map((option) => {
							const optionId = `${id}__${slug(option.name)}`
							optionItems.push({
								id: optionId,
								title: text(option.name),
								price_info: { price: option.price },
								suspension_info:
									option.available === false
										? {
												suspension: {
													suspend_until: 0,
													reason: 'Sold out',
												},
											}
										: null,
							})
							return { id: optionId, type: 'ITEM' }
						}),
					})
					return id
				}),
			},
			dietary_info: { labels: item.allergens },
			product_info: { is_alcoholic: Boolean(item.alcohol) },
			tax_info: { tax_rate: item.taxRate },
		}))
		return {
			menus: layoutMenus,
			categories,
			items: [...topItems, ...optionItems],
			modifier_groups: modifierGroups,
		}
	},
	decode(payload: Wire): Decoded {
		const items = new Map<string, Wire>(
			(payload.items ?? []).map((item: Wire) => [item.id, item]),
		)
		const groups = new Map<string, Wire>(
			(payload.modifier_groups ?? []).map((group: Wire) => [group.id, group]),
		)
		const categories = new Map<string, Wire>(
			(payload.categories ?? []).map((category: Wire) => [
				category.id,
				category,
			]),
		)
		const menus: RemoteMenu[] = []
		const rows = (payload.menus ?? []).flatMap((menu: Wire) => {
			const name = read(menu.title)
			const periods = menu.service_availability ?? []
			if (name !== ALL_DAY) {
				menus.push({
					name,
					days: periods.map((period: Wire) =>
						uberDays.indexOf(period.day_of_week),
					),
					start: periods[0]?.time_periods?.[0]?.start_time ?? '00:00',
					end: periods[0]?.time_periods?.[0]?.end_time ?? '23:59',
					...(menu.time_zone ? { timezone: menu.time_zone } : {}),
				})
			}
			return (menu.category_ids ?? []).flatMap((categoryId: string) => {
				const category = categories.get(categoryId)
				return (category?.entities ?? []).flatMap((entity: Wire) => {
					const entry = items.get(entity.id)
					if (!entry) return []
					return [
						{
							menu: name,
							category: read(category.title),
							item: {
								...base(String(entry.id)),
								name: read(entry.title),
								description: read(entry.description),
								price: Number(entry.price_info?.price ?? 0),
								imageUrl: entry.image_url ?? null,
								available: !entry.suspension_info,
								variations: readSizes(entry.variations),
								modifierGroups: (entry.modifier_group_ids?.ids ?? []).flatMap(
									(groupId: string) => {
										const group = groups.get(groupId)
										return group
											? [
													{
														name: read(group.title),
														min: Number(
															group.quantity_info?.quantity?.min_permitted ?? 0,
														),
														max: Number(
															group.quantity_info?.quantity?.max_permitted ?? 1,
														),
														options: (group.modifier_options ?? []).map(
															(option: Wire) => ({
																name: read(items.get(option.id)?.title),
																price: Number(
																	items.get(option.id)?.price_info?.price ?? 0,
																),
																available: !items.get(option.id)
																	?.suspension_info,
															}),
														),
													},
												]
											: []
									},
								),
								allergens: [...(entry.dietary_info?.labels ?? [])].sort(),
								alcohol: Boolean(entry.product_info?.is_alcoholic),
								taxRate: entry.tax_info?.tax_rate ?? null,
							},
						},
					]
				})
			})
		})
		return assemble(menus, rows)
	},
}

/* ---------------- DoorDash: store menus with open hours, categories, items, extras ---------------- */
export const doordashWire = {
	encode(items: RemoteItem[], menus: RemoteMenu[]): Wire[] {
		return layout(items, menus).map(({ menu, categories }) => ({
			merchant_supplied_id: `menu-${slug(menu.name).toLowerCase()}`,
			name: menu.name,
			time_zone: menu.timezone ?? null,
			open_hours: menu.days.map((day) => ({
				day_index: shortDays[day],
				start_time: menu.start,
				end_time: menu.end,
			})),
			categories: categories.map((category) => ({
				merchant_supplied_id: `cat-${slug(category.name).toLowerCase()}`,
				name: category.name,
				items: category.items.map((item) => ({
					merchant_supplied_id: item.id,
					name: item.name,
					description: item.description,
					price: item.price,
					original_image_url: item.imageUrl,
					is_active: item.available,
					is_alcohol: Boolean(item.alcohol),
					dietary_tags: item.allergens,
					variations: item.variations ?? [],
					extras: item.modifierGroups.map((group) => ({
						merchant_supplied_id: `${item.id}-x-${slug(group.name).toLowerCase()}`,
						name: group.name,
						min_num_options: group.min,
						max_num_options: group.max,
						options: group.options.map((option) => ({
							merchant_supplied_id: `${item.id}-o-${slug(option.name).toLowerCase()}`,
							name: option.name,
							price: option.price,
							is_active: option.available !== false,
						})),
					})),
				})),
			})),
		}))
	},
	decode(menusPayload: Wire[]): Decoded {
		const menus: RemoteMenu[] = []
		const rows = (menusPayload ?? []).flatMap((menu: Wire) => {
			const hours = menu.open_hours ?? []
			if (menu.name !== ALL_DAY) {
				menus.push({
					name: menu.name,
					days: hours.map((hour: Wire) => dayIndex(shortDays, hour.day_index)),
					start: hours[0]?.start_time ?? '00:00',
					end: hours[0]?.end_time ?? '23:59',
					...(menu.time_zone ? { timezone: menu.time_zone } : {}),
				})
			}
			return (menu.categories ?? []).flatMap((category: Wire) =>
				(category.items ?? []).map((entry: Wire) => ({
					menu: menu.name,
					category: category.name,
					item: {
						...base(String(entry.merchant_supplied_id)),
						name: entry.name,
						description: entry.description ?? '',
						price: Number(entry.price),
						imageUrl: entry.original_image_url ?? null,
						available: entry.is_active !== false,
						variations: readSizes(entry.variations),
						allergens: [...(entry.dietary_tags ?? [])].sort(),
						alcohol: Boolean(entry.is_alcohol),
						modifierGroups: (entry.extras ?? []).map((extra: Wire) => ({
							name: extra.name,
							min: Number(extra.min_num_options ?? 0),
							max: Number(extra.max_num_options ?? 1),
							options: (extra.options ?? []).map((option: Wire) => ({
								name: option.name,
								price: Number(option.price ?? 0),
								available: option.is_active !== false,
							})),
						})),
					},
				})),
			)
		})
		return assemble(menus, rows)
	},
}
