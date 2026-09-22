import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuOption,
	OrganizationMenuModifierGroupOptionAssignment,
} from './db.server.js'

async function main() {
	console.log('🍕 Seeding restaurant menu and locations...')

	// Find or fallback to first org
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
		console.error('No organization found to seed menu for.')
		process.exit(1)
	}

	console.log(`Using organization: ${org.name} (${org.slug}, id: ${org.id})`)

	// 1. Ensure default location exists
	const existingLocations = await db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, org.id))

	let locId: string
	if (existingLocations.length === 0) {
		const [loc] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: org.id,
				name: 'Downtown Flagship',
				slug: 'downtown-flagship',
				phone: '+1 (555) 234-5678',
				address: JSON.stringify({
					street: '123 Market St',
					city: 'San Francisco',
					state: 'CA',
					postalCode: '94105',
					country: 'US',
				}),
				onlineHours: JSON.stringify({
					monday: { open: '00:00', close: '23:59', closed: false },
					tuesday: { open: '00:00', close: '23:59', closed: false },
					wednesday: { open: '00:00', close: '23:59', closed: false },
					thursday: { open: '00:00', close: '23:59', closed: false },
					friday: { open: '00:00', close: '23:59', closed: false },
					saturday: { open: '00:00', close: '23:59', closed: false },
					sunday: { open: '00:00', close: '23:59', closed: false },
				}),
				storeHours: JSON.stringify({
					monday: { open: '00:00', close: '23:59', closed: false },
					tuesday: { open: '00:00', close: '23:59', closed: false },
					wednesday: { open: '00:00', close: '23:59', closed: false },
					thursday: { open: '00:00', close: '23:59', closed: false },
					friday: { open: '00:00', close: '23:59', closed: false },
					saturday: { open: '00:00', close: '23:59', closed: false },
					sunday: { open: '00:00', close: '23:59', closed: false },
				}),
				prepTime: 15,
				deliveryConfig: JSON.stringify({
					enabled: true,
					estimatedMinMinutes: 25,
					estimatedMaxMinutes: 45,
					flatFee: 3.99,
					freeDeliveryMinimum: 35.0,
				}),
				fulfillmentOptions: JSON.stringify({
					pickup: { enabled: true },
					delivery: { enabled: true },
				}),
				isActive: true,
				isDefault: true,
			})
			.returning({ id: OrganizationLocation.id })
		locId = loc.id
		console.log(`Created location: ${locId}`)
	} else {
		locId = existingLocations[0].id
		console.log(`Using existing location: ${locId}`)
	}

	// 2. Ensure menu exists
	const existingMenus = await db
		.select()
		.from(OrganizationMenu)
		.where(eq(OrganizationMenu.organizationId, org.id))

	let menuId: string
	if (existingMenus.length === 0) {
		const [m] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: org.id,
				displayName: 'Main All-Day Menu',
				internalName: 'all-day',
				menuType: 'online_pos_kiosk',
				nutritionalInfo: true,
				specialInstructions: true,
				availabilityStatus: 'available',
				position: 0,
			})
			.returning({ id: OrganizationMenu.id })
		menuId = m.id
		console.log(`Created menu: ${menuId}`)
	} else {
		menuId = existingMenus[0].id
		console.log(`Using existing menu: ${menuId}`)
	}

	// 3. Ensure categories exist
	const existingCats = await db
		.select()
		.from(OrganizationMenuCategory)
		.where(eq(OrganizationMenuCategory.organizationId, org.id))

	let cat1Id: string
	let cat2Id: string
	if (existingCats.length === 0) {
		const [c1] = await db
			.insert(OrganizationMenuCategory)
			.values({
				organizationId: org.id,
				displayName: 'Artisan Pizzas',
				internalName: 'pizzas',
				description:
					'Handcrafted sourdough pizzas baked at 900°F in our stone wood-fired oven.',
				availabilityStatus: 'available',
				position: 0,
			})
			.returning({ id: OrganizationMenuCategory.id })
		cat1Id = c1.id

		const [c2] = await db
			.insert(OrganizationMenuCategory)
			.values({
				organizationId: org.id,
				displayName: 'Beverages & Desserts',
				internalName: 'beverages-desserts',
				description:
					'Chilled sparkling Italian sodas and decadent house-made desserts.',
				availabilityStatus: 'available',
				position: 1,
			})
			.returning({ id: OrganizationMenuCategory.id })
		cat2Id = c2.id

		await db.insert(OrganizationMenuCategoryAssignment).values([
			{ menuId, categoryId: cat1Id, position: 0 },
			{ menuId, categoryId: cat2Id, position: 1 },
		])
		console.log(`Created categories: ${cat1Id}, ${cat2Id}`)
	} else {
		cat1Id = existingCats[0].id
		cat2Id = existingCats[1]?.id || existingCats[0].id
		console.log('Using existing categories')
	}

	// 4. Ensure Options exist
	const existingOpts = await db
		.select()
		.from(OrganizationMenuOption)
		.where(eq(OrganizationMenuOption.organizationId, org.id))

	let optCrust1Id: string
	let optCrust2Id: string
	let optTop1Id: string
	let optTop2Id: string

	if (existingOpts.length === 0) {
		const [o1] = await db
			.insert(OrganizationMenuOption)
			.values({
				organizationId: org.id,
				displayName: 'Neapolitan Thin Crust',
				internalName: 'thin-crust',
				description:
					'Naturally fermented 48h sourdough crust with blistered cornicione.',
				price: 0,
				minSelections: 0,
				position: 0,
			})
			.returning({ id: OrganizationMenuOption.id })
		optCrust1Id = o1.id

		const [o2] = await db
			.insert(OrganizationMenuOption)
			.values({
				organizationId: org.id,
				displayName: 'Gluten-Free Cauliflower Crust',
				internalName: 'gf-crust',
				description:
					'Crispy certified gluten-free crust crafted with cauliflower and rice flour.',
				price: 3.5,
				isGlutenFree: true,
				minSelections: 0,
				position: 1,
			})
			.returning({ id: OrganizationMenuOption.id })
		optCrust2Id = o2.id

		const [o3] = await db
			.insert(OrganizationMenuOption)
			.values({
				organizationId: org.id,
				displayName: 'Fresh Buffalo Mozzarella',
				internalName: 'buff-mozz',
				description: 'Imported Campana D.O.P. creamy buffalo mozzarella.',
				price: 2.75,
				isVegetarian: true,
				minSelections: 0,
				position: 0,
			})
			.returning({ id: OrganizationMenuOption.id })
		optTop1Id = o3.id

		const [o4] = await db
			.insert(OrganizationMenuOption)
			.values({
				organizationId: org.id,
				displayName: 'Prosciutto di Parma 24-Mo',
				internalName: 'prosciutto',
				description:
					'Aged 24 months, sliced paper-thin and draped fresh after baking.',
				price: 4.25,
				minSelections: 0,
				position: 1,
			})
			.returning({ id: OrganizationMenuOption.id })
		optTop2Id = o4.id
		console.log('Created options')
	} else {
		optCrust1Id = existingOpts[0].id
		optCrust2Id = existingOpts[1]?.id || existingOpts[0].id
		optTop1Id = existingOpts[2]?.id || existingOpts[0].id
		optTop2Id = existingOpts[3]?.id || existingOpts[0].id
		console.log('Using existing options')
	}

	// 5. Modifier Groups
	const existingGroups = await db
		.select()
		.from(OrganizationMenuModifierGroup)
		.where(eq(OrganizationMenuModifierGroup.organizationId, org.id))

	let mgCrustId: string
	let mgTopId: string

	if (existingGroups.length === 0) {
		const [mg1] = await db
			.insert(OrganizationMenuModifierGroup)
			.values({
				organizationId: org.id,
				name: 'Choice of Crust',
				internalName: 'crust-choice',
				selectionType: 'single',
				minSelections: 1,
				maxSelections: 1,
				position: 0,
			})
			.returning({ id: OrganizationMenuModifierGroup.id })
		mgCrustId = mg1.id

		const [mg2] = await db
			.insert(OrganizationMenuModifierGroup)
			.values({
				organizationId: org.id,
				name: 'Extra Gourmet Toppings',
				internalName: 'extra-toppings',
				selectionType: 'multiple',
				minSelections: 0,
				maxSelections: 5,
				position: 1,
			})
			.returning({ id: OrganizationMenuModifierGroup.id })
		mgTopId = mg2.id

		await db.insert(OrganizationMenuModifierGroupOptionAssignment).values([
			{ modifierGroupId: mgCrustId, optionId: optCrust1Id, position: 0 },
			{ modifierGroupId: mgCrustId, optionId: optCrust2Id, position: 1 },
			{ modifierGroupId: mgTopId, optionId: optTop1Id, position: 0 },
			{ modifierGroupId: mgTopId, optionId: optTop2Id, position: 1 },
		])
		console.log('Created modifier groups & linked options')
	} else {
		mgCrustId = existingGroups[0].id
		mgTopId = existingGroups[1]?.id || existingGroups[0].id
		console.log('Using existing modifier groups')
	}

	// 6. Items
	const existingItems = await db
		.select()
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, org.id))

	if (existingItems.length === 0) {
		const [item1] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: org.id,
				displayName: 'Margherita D.O.P.',
				internalName: 'margherita',
				description:
					'San Marzano tomatoes, fior di latte, fresh basil leaves, sea salt, and extra virgin olive oil.',
				price: 18.0,
				isVegetarian: true,
				isPopular: true,
				calorieMin: 780,
				calorieMax: 850,
				availabilityStatus: 'available',
				position: 0,
			})
			.returning({ id: OrganizationMenuItem.id })

		const [item2] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: org.id,
				displayName: 'Tartufo & Forest Mushroom',
				internalName: 'tartufo-mushroom',
				description:
					'Black truffle crema, sautéed cremini and chanterelles, fontina cheese, fresh thyme.',
				price: 22.5,
				isVegetarian: true,
				calorieMin: 850,
				calorieMax: 920,
				availabilityStatus: 'available',
				position: 1,
			})
			.returning({ id: OrganizationMenuItem.id })

		const [item3] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: org.id,
				displayName: 'San Pellegrino Aranciata',
				internalName: 'san-pellegrino',
				description:
					'Crisp, sparkling Italian orange beverage served over ice with fresh citrus wedge.',
				price: 4.5,
				isGlutenFree: true,
				isVegetarian: true,
				availabilityStatus: 'available',
				position: 0,
			})
			.returning({ id: OrganizationMenuItem.id })

		const [item4] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: org.id,
				displayName: 'Traditional Venetian Tiramisu',
				internalName: 'tiramisu',
				description:
					'Savoiardi ladyfingers soaked in espresso, mascarpone zabaglione, and Valrhona dark cocoa.',
				price: 9.5,
				isVegetarian: true,
				isPopular: true,
				availabilityStatus: 'available',
				position: 1,
			})
			.returning({ id: OrganizationMenuItem.id })

		// Category assignments
		await db.insert(OrganizationMenuItemCategoryAssignment).values([
			{ categoryId: cat1Id, itemId: item1.id, position: 0 },
			{ categoryId: cat1Id, itemId: item2.id, position: 1 },
			{ categoryId: cat2Id, itemId: item3.id, position: 0 },
			{ categoryId: cat2Id, itemId: item4.id, position: 1 },
		])

		// Modifier group assignments to pizza items
		await db.insert(OrganizationMenuItemModifierGroupAssignment).values([
			{ itemId: item1.id, modifierGroupId: mgCrustId, position: 0 },
			{ itemId: item1.id, modifierGroupId: mgTopId, position: 1 },
			{ itemId: item2.id, modifierGroupId: mgCrustId, position: 0 },
			{ itemId: item2.id, modifierGroupId: mgTopId, position: 1 },
		])
		console.log('Created items and assignments successfully!')
	} else {
		console.log('Items already exist:', existingItems.length)
	}

	console.log('✅ Menu and location seeding finished successfully!')
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})
