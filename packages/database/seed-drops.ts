import {
	and,
	asc,
	db,
	eq,
	Organization,
	OrganizationDrop,
	OrganizationDropInventory,
	OrganizationDropPickupWindow,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
} from './db.server.js'

/**
 * Seeds a drop menu and three drops (live, scheduled, closed) for the `acme`
 * organization so the Sites `/drops` and `/drop/[slug]` pages can be checked
 * locally. Safe to re-run: every row is looked up by a stable key first.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

const localized = (en: string, ar: string) => JSON.stringify({ en, ar })

const ALL_DAY = JSON.stringify({
	monday: { open: '00:00', close: '23:59', closed: false },
	tuesday: { open: '00:00', close: '23:59', closed: false },
	wednesday: { open: '00:00', close: '23:59', closed: false },
	thursday: { open: '00:00', close: '23:59', closed: false },
	friday: { open: '00:00', close: '23:59', closed: false },
	saturday: { open: '00:00', close: '23:59', closed: false },
	sunday: { open: '00:00', close: '23:59', closed: false },
})

/** Calendar date (`YYYY-MM-DD`) for an instant in a timezone. */
function dateInZone(instant: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(instant)
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
	return `${get('year')}-${get('month')}-${get('day')}`
}

function daysFromNow(days: number): Date {
	return new Date(Date.now() + days * DAY_MS)
}

function roundToMinutes(date: Date, minutes: number): Date {
	const step = minutes * MINUTE_MS
	return new Date(Math.round(date.getTime() / step) * step)
}

type ItemSpec = {
	key: string
	categoryKey: string
	displayName: string
	description: string
	price: number
	position: number
	isVegetarian?: boolean
	isGlutenFree?: boolean
	isPopular?: boolean
	allergens?: string[]
	calorieMin?: number
	calorieMax?: number
	variations?: string
	modifierGroupKeys?: string[]
}

async function main() {
	console.log('📦 Seeding drops...')

	let [org] = await db
		.select()
		.from(Organization)
		.where(eq(Organization.slug, 'acme'))
		.limit(1)
	if (!org) {
		const [firstOrg] = await db.select().from(Organization).limit(1)
		org = firstOrg
	}
	if (!org) {
		console.error('No organization found to seed drops for.')
		process.exit(1)
	}
	console.log(`Using organization: ${org.name} (${org.slug}, id: ${org.id})`)
	const orgId = org.id

	// 1. Locations: reuse what exists, top up to two.
	let locations = await db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, orgId))
		.orderBy(
			asc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.createdAt),
		)
	locations.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))

	if (locations.length === 0) {
		await db.insert(OrganizationLocation).values({
			organizationId: orgId,
			name: localized('Downtown Flagship', 'الفرع الرئيسي وسط المدينة'),
			slug: 'downtown-flagship',
			phone: '+1 (555) 234-5678',
			timezone: 'America/Los_Angeles',
			address: JSON.stringify({
				streetNumber: '123',
				streetName: 'Market St',
				city: 'San Francisco',
				state: 'CA',
				postalCode: '94105',
				country: 'US',
			}),
			onlineHours: ALL_DAY,
			storeHours: ALL_DAY,
			prepTime: 15,
			fulfillmentOptions: JSON.stringify({
				pickup: { enabled: true },
				delivery: { enabled: false },
			}),
			isActive: true,
			isDefault: true,
		})
		console.log('Created location: Downtown Flagship')
	}
	if (locations.length < 2) {
		const [existing] = await db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, orgId),
					eq(OrganizationLocation.slug, 'eastside-market'),
				),
			)
		if (!existing) {
			await db.insert(OrganizationLocation).values({
				organizationId: orgId,
				name: localized('Eastside Market', 'سوق الجانب الشرقي'),
				slug: 'eastside-market',
				phone: '+1 (512) 555-0147',
				timezone: 'America/Chicago',
				taxRate: 8.25,
				address: JSON.stringify({
					streetNumber: '2200',
					streetName: 'E Cesar Chavez St',
					city: 'Austin',
					state: 'TX',
					postalCode: '78702',
					country: 'US',
				}),
				onlineHours: ALL_DAY,
				storeHours: ALL_DAY,
				prepTime: 15,
				fulfillmentOptions: JSON.stringify({
					pickup: { enabled: true },
					delivery: { enabled: false },
				}),
				isActive: true,
				isDefault: false,
			})
			console.log('Created location: Eastside Market')
		}
	}
	locations = await db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, orgId))
	locations.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
	const locationA = locations[0]!
	const locationB = locations[1] ?? locationA
	console.log(
		`Pickup locations: ${locationA.name} (${locationA.timezone}), ${locationB.name} (${locationB.timezone})`,
	)

	// 2. Drop menu
	const MENU_KEY = 'drop-bake-box'
	let [menu] = await db
		.select()
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.organizationId, orgId),
				eq(OrganizationMenu.internalName, MENU_KEY),
			),
		)
	if (!menu) {
		;[menu] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: orgId,
				displayName: localized('Bake Box Drop Menu', 'قائمة صندوق المخبوزات'),
				internalName: MENU_KEY,
				menuType: 'drop',
				nutritionalInfo: true,
				specialInstructions: true,
				availabilityStatus: 'available',
				position: 50,
			})
			.returning()
		console.log(`Created drop menu: ${menu!.id}`)
	} else {
		console.log(`Using drop menu: ${menu.id}`)
	}
	const menuId = menu!.id

	// 3. Categories
	const categorySpecs = [
		{
			key: 'drop-loaves',
			displayName: localized('Loaves', 'أرغفة'),
			description: localized(
				'Naturally leavened and baked the morning of your pickup.',
				'مخمّرة طبيعياً وتُخبز صباح يوم الاستلام.',
			),
			position: 0,
		},
		{
			key: 'drop-pastries',
			displayName: localized('Pastries & Sweets', 'معجنات وحلويات'),
			description: localized(
				'Laminated doughs, pies and a few things for breakfast.',
				'عجائن مورّقة وفطائر وبعض أصناف الإفطار.',
			),
			position: 1,
		},
	]
	const categoryIds = new Map<string, string>()
	for (const spec of categorySpecs) {
		let [row] = await db
			.select({ id: OrganizationMenuCategory.id })
			.from(OrganizationMenuCategory)
			.where(
				and(
					eq(OrganizationMenuCategory.organizationId, orgId),
					eq(OrganizationMenuCategory.internalName, spec.key),
				),
			)
		if (!row) {
			;[row] = await db
				.insert(OrganizationMenuCategory)
				.values({
					organizationId: orgId,
					displayName: spec.displayName,
					internalName: spec.key,
					description: spec.description,
					availabilityStatus: 'available',
					position: 20 + spec.position,
				})
				.returning({ id: OrganizationMenuCategory.id })
		}
		categoryIds.set(spec.key, row!.id)
		const [assignment] = await db
			.select({ id: OrganizationMenuCategoryAssignment.id })
			.from(OrganizationMenuCategoryAssignment)
			.where(
				and(
					eq(OrganizationMenuCategoryAssignment.menuId, menuId),
					eq(OrganizationMenuCategoryAssignment.categoryId, row!.id),
				),
			)
		if (!assignment) {
			await db.insert(OrganizationMenuCategoryAssignment).values({
				menuId,
				categoryId: row!.id,
				position: spec.position,
			})
		}
	}
	console.log('Categories ready')

	// 4. Options + modifier groups
	const optionSpecs = [
		{
			key: 'drop-glaze-cream-cheese',
			displayName: localized('Cream cheese glaze', 'صوص الجبن الكريمي'),
			price: 0,
			isVegetarian: true,
			position: 0,
		},
		{
			key: 'drop-glaze-vanilla',
			displayName: localized('Vanilla glaze', 'صوص الفانيليا'),
			price: 0,
			isVegetarian: true,
			position: 1,
		},
		{
			key: 'drop-glaze-none',
			displayName: localized('No glaze', 'بدون صوص'),
			price: 0,
			isVegetarian: true,
			position: 2,
		},
		{
			key: 'drop-addon-jam',
			displayName: localized(
				'Strawberry jam (8 oz)',
				'مربى الفراولة (٨ أونصة)',
			),
			price: 4,
			isVegetarian: true,
			isGlutenFree: true,
			position: 0,
		},
		{
			key: 'drop-addon-butter',
			displayName: localized('Cultured butter', 'زبدة مخمّرة'),
			price: 3.5,
			isVegetarian: true,
			isGlutenFree: true,
			position: 1,
		},
		{
			key: 'drop-addon-honey',
			displayName: localized('Wildflower honey', 'عسل الزهور البرية'),
			price: 6,
			isGlutenFree: true,
			position: 2,
		},
	]
	const optionIds = new Map<string, string>()
	for (const spec of optionSpecs) {
		let [row] = await db
			.select({ id: OrganizationMenuOption.id })
			.from(OrganizationMenuOption)
			.where(
				and(
					eq(OrganizationMenuOption.organizationId, orgId),
					eq(OrganizationMenuOption.internalName, spec.key),
				),
			)
		if (!row) {
			;[row] = await db
				.insert(OrganizationMenuOption)
				.values({
					organizationId: orgId,
					displayName: spec.displayName,
					internalName: spec.key,
					price: spec.price,
					isVegetarian: spec.isVegetarian ?? false,
					isGlutenFree: spec.isGlutenFree ?? false,
					minSelections: 0,
					position: spec.position,
				})
				.returning({ id: OrganizationMenuOption.id })
		}
		optionIds.set(spec.key, row!.id)
	}

	const groupSpecs = [
		{
			key: 'drop-glaze',
			name: localized('Glaze', 'الصوص'),
			selectionType: 'single',
			minSelections: 1,
			maxSelections: 1,
			options: [
				{ key: 'drop-glaze-cream-cheese', isDefault: true },
				{ key: 'drop-glaze-vanilla' },
				{ key: 'drop-glaze-none' },
			],
		},
		{
			key: 'drop-addons',
			name: localized('Add-ons', 'إضافات'),
			selectionType: 'multiple',
			minSelections: 0,
			maxSelections: 3,
			options: [
				{ key: 'drop-addon-jam' },
				{ key: 'drop-addon-butter' },
				{ key: 'drop-addon-honey' },
			],
		},
	]
	const groupIds = new Map<string, string>()
	for (const [index, spec] of groupSpecs.entries()) {
		let [row] = await db
			.select({ id: OrganizationMenuModifierGroup.id })
			.from(OrganizationMenuModifierGroup)
			.where(
				and(
					eq(OrganizationMenuModifierGroup.organizationId, orgId),
					eq(OrganizationMenuModifierGroup.internalName, spec.key),
				),
			)
		if (!row) {
			;[row] = await db
				.insert(OrganizationMenuModifierGroup)
				.values({
					organizationId: orgId,
					name: spec.name,
					internalName: spec.key,
					selectionType: spec.selectionType,
					minSelections: spec.minSelections,
					maxSelections: spec.maxSelections,
					position: 10 + index,
				})
				.returning({ id: OrganizationMenuModifierGroup.id })
		}
		groupIds.set(spec.key, row!.id)
		for (const [position, option] of spec.options.entries()) {
			const optionId = optionIds.get(option.key)!
			const [existing] = await db
				.select({ id: OrganizationMenuModifierGroupOptionAssignment.id })
				.from(OrganizationMenuModifierGroupOptionAssignment)
				.where(
					and(
						eq(
							OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
							row!.id,
						),
						eq(
							OrganizationMenuModifierGroupOptionAssignment.optionId,
							optionId,
						),
					),
				)
			if (!existing) {
				await db.insert(OrganizationMenuModifierGroupOptionAssignment).values({
					modifierGroupId: row!.id,
					optionId,
					isDefault: option.isDefault ?? false,
					position,
				})
			}
		}
	}
	console.log('Modifier groups ready')

	// 5. Items
	const sourdoughVariations = JSON.stringify({
		groups: [
			{
				id: 'size',
				name: 'Size',
				values: [
					{ id: 'half', name: 'Half loaf' },
					{ id: 'whole', name: 'Whole loaf' },
				],
			},
		],
		variants: [
			{
				id: 'size-half',
				valueIds: ['half'],
				price: 8,
				imageKey: null,
				availabilityStatus: 'available',
				unavailableUntil: null,
			},
			{
				id: 'size-whole',
				valueIds: ['whole'],
				price: 14,
				imageKey: null,
				availabilityStatus: 'available',
				unavailableUntil: null,
			},
		],
	})

	const itemSpecs: ItemSpec[] = [
		{
			key: 'drop-country-sourdough',
			categoryKey: 'drop-loaves',
			displayName: localized('Country Sourdough', 'خبز الساوردو الريفي'),
			description: localized(
				'Our everyday loaf: stone-ground wheat, a 36-hour ferment and a deep, blistered crust.',
				'رغيفنا اليومي: قمح مطحون على الحجر، تخمير ٣٦ ساعة وقشرة داكنة مقرمشة.',
			),
			price: 14,
			position: 0,
			isVegetarian: true,
			isPopular: true,
			allergens: ['gluten'],
			calorieMin: 1100,
			calorieMax: 2200,
			variations: sourdoughVariations,
			modifierGroupKeys: ['drop-addons'],
		},
		{
			key: 'drop-seeded-rye',
			categoryKey: 'drop-loaves',
			displayName: localized('Seeded Rye', 'خبز الجاودار بالبذور'),
			description: localized(
				'Dark rye with caraway, sunflower and flax. Slices thin, keeps all week.',
				'جاودار داكن مع الكراوية وبذور دوار الشمس والكتان. يُقطّع رقيقاً ويحتفظ بطزاجته طوال الأسبوع.',
			),
			price: 11,
			position: 1,
			isVegetarian: true,
			allergens: ['gluten', 'sesame'],
			calorieMin: 1500,
			calorieMax: 1500,
		},
		{
			key: 'drop-focaccia',
			categoryKey: 'drop-loaves',
			displayName: localized('Rosemary Focaccia', 'فوكاتشا بإكليل الجبل'),
			description: localized(
				'Half sheet, olive oil-soaked, flaky salt and fresh rosemary.',
				'نصف صينية مشبعة بزيت الزيتون مع ملح خشن وإكليل الجبل الطازج.',
			),
			price: 12,
			position: 2,
			isVegetarian: true,
			allergens: ['gluten'],
		},
		{
			key: 'drop-cinnamon-rolls',
			categoryKey: 'drop-pastries',
			displayName: localized(
				'Cinnamon Rolls (box of 4)',
				'لفائف القرفة (علبة من ٤)',
			),
			description: localized(
				'Brioche rolls with a brown butter cinnamon swirl. Choose your glaze.',
				'لفائف بريوش مع دوامة قرفة بالزبدة البنية. اختر الصوص المفضل لديك.',
			),
			price: 16,
			position: 0,
			isVegetarian: true,
			isPopular: true,
			allergens: ['gluten', 'dairy', 'eggs'],
			calorieMin: 420,
			calorieMax: 480,
			modifierGroupKeys: ['drop-glaze'],
		},
		{
			key: 'drop-croissant-box',
			categoryKey: 'drop-pastries',
			displayName: localized('Croissant Box (6)', 'علبة كرواسون (٦)'),
			description: localized(
				'Three butter, two almond, one pain au chocolat. Best the day of pickup.',
				'ثلاثة بالزبدة واثنان باللوز وواحد بالشوكولاتة. الأفضل في يوم الاستلام.',
			),
			price: 24,
			position: 1,
			isVegetarian: true,
			allergens: ['gluten', 'dairy', 'eggs', 'tree_nuts'],
			modifierGroupKeys: ['drop-addons'],
		},
		{
			key: 'drop-pumpkin-pie',
			categoryKey: 'drop-pastries',
			displayName: localized(
				'Brown Butter Pumpkin Pie',
				'فطيرة اليقطين بالزبدة البنية',
			),
			description: localized(
				'Nine-inch pie, all-butter crust, roasted sugar pumpkin. Serves 8.',
				'فطيرة ٩ بوصات بقشرة زبدة كاملة ويقطين محمّص. تكفي ٨ أشخاص.',
			),
			price: 32,
			position: 2,
			isVegetarian: true,
			allergens: ['gluten', 'dairy', 'eggs'],
			calorieMin: 320,
			calorieMax: 380,
		},
	]

	const [sampleImage] = await db
		.select({ imageKey: OrganizationMenuItem.imageKey })
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, orgId))
		.limit(1)

	const itemIds = new Map<string, string>()
	for (const spec of itemSpecs) {
		let [row] = await db
			.select({ id: OrganizationMenuItem.id })
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, orgId),
					eq(OrganizationMenuItem.internalName, spec.key),
				),
			)
		if (!row) {
			;[row] = await db
				.insert(OrganizationMenuItem)
				.values({
					organizationId: orgId,
					displayName: spec.displayName,
					internalName: spec.key,
					description: spec.description,
					price: spec.price,
					imageKey: spec.isPopular ? (sampleImage?.imageKey ?? null) : null,
					variations:
						spec.variations ?? JSON.stringify({ groups: [], variants: [] }),
					isVegetarian: spec.isVegetarian ?? false,
					isGlutenFree: spec.isGlutenFree ?? false,
					allergens: JSON.stringify(spec.allergens ?? []),
					calorieMin: spec.calorieMin ?? null,
					calorieMax: spec.calorieMax ?? null,
					isPopular: spec.isPopular ?? false,
					availabilityStatus: 'available',
					position: spec.position,
				})
				.returning({ id: OrganizationMenuItem.id })
		}
		itemIds.set(spec.key, row!.id)

		const categoryId = categoryIds.get(spec.categoryKey)!
		const [categoryAssignment] = await db
			.select({ id: OrganizationMenuItemCategoryAssignment.id })
			.from(OrganizationMenuItemCategoryAssignment)
			.where(
				and(
					eq(OrganizationMenuItemCategoryAssignment.categoryId, categoryId),
					eq(OrganizationMenuItemCategoryAssignment.itemId, row!.id),
				),
			)
		if (!categoryAssignment) {
			await db.insert(OrganizationMenuItemCategoryAssignment).values({
				categoryId,
				itemId: row!.id,
				position: spec.position,
			})
		}

		for (const [position, groupKey] of (
			spec.modifierGroupKeys ?? []
		).entries()) {
			const modifierGroupId = groupIds.get(groupKey)!
			const [groupAssignment] = await db
				.select({ id: OrganizationMenuItemModifierGroupAssignment.id })
				.from(OrganizationMenuItemModifierGroupAssignment)
				.where(
					and(
						eq(OrganizationMenuItemModifierGroupAssignment.itemId, row!.id),
						eq(
							OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
							modifierGroupId,
						),
					),
				)
			if (!groupAssignment) {
				await db.insert(OrganizationMenuItemModifierGroupAssignment).values({
					itemId: row!.id,
					modifierGroupId,
					position,
				})
			}
		}
	}
	console.log(`Items ready (${itemIds.size})`)

	// 6. Drops
	const now = roundToMinutes(new Date(), 15)
	type WindowSpec = {
		locationId: string
		timeZone: string
		date: string
		startTime: string
		endTime: string
		slotIntervalMinutes: number
		orderLeadTimeMinutes: number
		maxOrdersPerSlot?: number | null
	}
	type InventorySpec = {
		entityType: 'item' | 'category'
		entityId: string
		inventory?: number | null
		maxPerOrder?: number | null
	}
	type DropSpec = {
		slug: string
		title: string
		description: string
		status: 'scheduled' | 'live' | 'closed'
		ordersOpenAt: Date
		ordersCloseAt: Date
		showMenuPreview: boolean
		showInventoryRemaining: boolean
		checkoutHoldMinutes: number
		windows: WindowSpec[]
		inventory: InventorySpec[]
	}

	const dropSpecs: DropSpec[] = [
		{
			slug: 'weekend-bake-box',
			title: localized('Weekend Bake Box', 'صندوق مخبوزات نهاية الأسبوع'),
			description: localized(
				'Pre-order loaves and pastries for the weekend. Everything is baked the morning of your pickup, so quantities are limited and the oven is the only thing deciding how many we can make.',
				'اطلب مسبقاً الأرغفة والمعجنات لنهاية الأسبوع. يُخبز كل شيء صباح يوم الاستلام، لذلك الكميات محدودة.',
			),
			status: 'live',
			ordersOpenAt: new Date(now.getTime() - 1 * DAY_MS),
			ordersCloseAt: new Date(now.getTime() + 2 * DAY_MS),
			showMenuPreview: true,
			showInventoryRemaining: true,
			checkoutHoldMinutes: 5,
			windows: [
				{
					locationId: locationA.id,
					timeZone: locationA.timezone,
					date: dateInZone(daysFromNow(1), locationA.timezone),
					startTime: '09:00',
					endTime: '12:00',
					slotIntervalMinutes: 30,
					orderLeadTimeMinutes: 60,
					maxOrdersPerSlot: 12,
				},
				{
					locationId: locationB.id,
					timeZone: locationB.timezone,
					date: dateInZone(daysFromNow(2), locationB.timezone),
					startTime: '10:00',
					endTime: '13:00',
					slotIntervalMinutes: 15,
					orderLeadTimeMinutes: 0,
					maxOrdersPerSlot: null,
				},
			],
			inventory: [
				{
					entityType: 'item',
					entityId: itemIds.get('drop-country-sourdough')!,
					inventory: 3,
					maxPerOrder: 2,
				},
				{
					entityType: 'item',
					entityId: itemIds.get('drop-pumpkin-pie')!,
					inventory: 0,
				},
				{
					entityType: 'category',
					entityId: categoryIds.get('drop-pastries')!,
					inventory: 10,
				},
				{
					entityType: 'item',
					entityId: itemIds.get('drop-croissant-box')!,
					maxPerOrder: 4,
				},
			],
		},
		{
			slug: 'thanksgiving-preorders',
			title: localized('Thanksgiving Pre-orders', 'طلبات عيد الشكر المسبقة'),
			description: localized(
				'Pies, dinner rolls and a few loaves for the table. Ordering opens soon; browse the menu now and set a reminder.',
				'فطائر وخبز العشاء وبعض الأرغفة للمائدة. يفتح الطلب قريباً؛ تصفّح القائمة الآن واضبط تذكيراً.',
			),
			status: 'scheduled',
			ordersOpenAt: new Date(now.getTime() + 2 * DAY_MS),
			ordersCloseAt: new Date(now.getTime() + 6 * DAY_MS),
			showMenuPreview: true,
			showInventoryRemaining: false,
			checkoutHoldMinutes: 10,
			windows: [
				{
					locationId: locationA.id,
					timeZone: locationA.timezone,
					date: dateInZone(daysFromNow(8), locationA.timezone),
					startTime: '10:00',
					endTime: '14:00',
					slotIntervalMinutes: 30,
					orderLeadTimeMinutes: 24 * 60,
					maxOrdersPerSlot: 20,
				},
			],
			inventory: [
				{
					entityType: 'item',
					entityId: itemIds.get('drop-pumpkin-pie')!,
					inventory: 40,
					maxPerOrder: 2,
				},
			],
		},
		{
			slug: 'summer-pop-up',
			title: localized('Summer Pop-up', 'الفعالية الصيفية'),
			description: localized(
				'Stone fruit galettes, focaccia and cold brew at the farmers market. Thanks to everyone who came out.',
				'فطائر الفواكه الصيفية والفوكاتشا والقهوة الباردة في سوق المزارعين. شكراً لكل من حضر.',
			),
			status: 'closed',
			ordersOpenAt: new Date(now.getTime() - 45 * DAY_MS),
			ordersCloseAt: new Date(now.getTime() - 30 * DAY_MS),
			showMenuPreview: true,
			showInventoryRemaining: true,
			checkoutHoldMinutes: 5,
			windows: [
				{
					locationId: locationB.id,
					timeZone: locationB.timezone,
					date: dateInZone(daysFromNow(-28), locationB.timezone),
					startTime: '08:00',
					endTime: '11:00',
					slotIntervalMinutes: 30,
					orderLeadTimeMinutes: 0,
					maxOrdersPerSlot: null,
				},
			],
			inventory: [],
		},
	]

	for (const spec of dropSpecs) {
		const values = {
			organizationId: orgId,
			menuId,
			title: spec.title,
			slug: spec.slug,
			description: spec.description,
			status: spec.status,
			ordersOpenAt: spec.ordersOpenAt,
			ordersCloseAt: spec.ordersCloseAt,
			visibility: 'public',
			checkoutHoldMinutes: spec.checkoutHoldMinutes,
			showOrdersOpenTime: true,
			showMenuPreview: spec.showMenuPreview,
			showInventoryRemaining: spec.showInventoryRemaining,
			includeGiftCard: false,
		}
		let [drop] = await db
			.select({ id: OrganizationDrop.id })
			.from(OrganizationDrop)
			.where(
				and(
					eq(OrganizationDrop.organizationId, orgId),
					eq(OrganizationDrop.slug, spec.slug),
				),
			)
		if (drop) {
			await db
				.update(OrganizationDrop)
				.set(values)
				.where(eq(OrganizationDrop.id, drop.id))
			// Windows and inventory are replaced so the dates follow "now".
			await db
				.delete(OrganizationDropPickupWindow)
				.where(eq(OrganizationDropPickupWindow.dropId, drop.id))
			await db
				.delete(OrganizationDropInventory)
				.where(eq(OrganizationDropInventory.dropId, drop.id))
			console.log(`Updated drop: ${spec.slug}`)
		} else {
			;[drop] = await db
				.insert(OrganizationDrop)
				.values(values)
				.returning({ id: OrganizationDrop.id })
			console.log(`Created drop: ${spec.slug}`)
		}
		const dropId = drop!.id

		if (spec.windows.length) {
			await db.insert(OrganizationDropPickupWindow).values(
				spec.windows.map((window) => ({
					dropId,
					locationId: window.locationId,
					date: window.date,
					startTime: window.startTime,
					endTime: window.endTime,
					slotIntervalMinutes: window.slotIntervalMinutes,
					maxOrdersPerSlot: window.maxOrdersPerSlot ?? null,
					orderLeadTimeMinutes: window.orderLeadTimeMinutes,
				})),
			)
		}
		if (spec.inventory.length) {
			await db.insert(OrganizationDropInventory).values(
				spec.inventory.map((entry) => ({
					dropId,
					entityType: entry.entityType,
					entityId: entry.entityId,
					inventory: entry.inventory ?? null,
					maxPerOrder: entry.maxPerOrder ?? null,
					maxPerPickupSlot: null,
				})),
			)
		}
		for (const window of spec.windows) {
			console.log(
				`  window ${window.date} ${window.startTime}-${window.endTime} (${window.timeZone}, ${window.slotIntervalMinutes}-min slots, ${window.orderLeadTimeMinutes}-min lead)`,
			)
		}
	}

	console.log('✅ Drops seeding finished successfully!')
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})
