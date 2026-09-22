import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
} from './db.server.js'

async function main() {
	console.log('🌍 Updating restaurant data with Arabic localization...')

	// 1. Find organization 'acme'
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
		console.error('No organization found.')
		process.exit(1)
	}

	console.log(
		`Targeting organization: ${org.name} (${org.slug}, id: ${org.id})`,
	)

	// Update organization siteLocales
	await db
		.update(Organization)
		.set({
			siteLocales: JSON.stringify(['en', 'ar']),
			siteDefaultLocale: 'en',
		})
		.where(eq(Organization.id, org.id))
	console.log('✅ Updated Organization.siteLocales to ["en", "ar"]')

	// 2. Update Locations
	const locations = await db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, org.id))

	if (locations.length === 1) {
		const [loc2] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: org.id,
				name: JSON.stringify({
					en: 'Waterfront Kitchen (Toronto)',
					ar: 'مطبخ الواجهة البحرية (تورونتو)',
				}),
				slug: 'waterfront-kitchen',
				phone: '+1 (416) 555-0199',
				address: JSON.stringify({
					street: '490 Bloor St W',
					city: 'Toronto',
					state: 'ON',
					postalCode: 'M5S 1X8',
					country: 'CA',
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
				prepTime: 20,
				deliveryConfig: JSON.stringify({
					enabled: true,
					estimatedMinMinutes: 30,
					estimatedMaxMinutes: 50,
					flatFee: 4.99,
					freeDeliveryMinimum: 40.0,
				}),
				fulfillmentOptions: JSON.stringify({
					pickup: { enabled: true },
					delivery: { enabled: true },
				}),
				isActive: true,
				isDefault: false,
			})
			.returning({ id: OrganizationLocation.id })
		console.log(`Created second location: ${loc2.id}`)
	}

	const updatedLocations = await db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, org.id))

	for (const loc of updatedLocations) {
		let arName = 'فرع وسط المدينة الرئيسي'
		let locEnName = loc.name
		let addressPatch: string | undefined
		if (loc.name.includes('Waterfront') || loc.slug.includes('waterfront')) {
			locEnName = 'Waterfront Kitchen (Toronto)'
			arName = 'مطبخ الواجهة البحرية (تورونتو)'
			addressPatch = JSON.stringify({
				street: '490 Bloor St W',
				city: 'Toronto',
				state: 'ON',
				postalCode: 'M5S 1X8',
				country: 'CA',
			})
		} else if (loc.name.includes('Downtown') || loc.slug.includes('downtown')) {
			locEnName = 'Downtown Flagship'
			arName = 'بيتزا وسط المدينة'
			addressPatch = JSON.stringify({
				street: '123 Market St',
				city: 'San Francisco',
				state: 'CA',
				postalCode: '94105',
				country: 'US',
			})
		}
		if (loc.name.startsWith('{')) {
			try {
				const parsed = JSON.parse(loc.name)
				if (parsed.en && !loc.slug.includes('waterfront')) {
					locEnName = parsed.en
				}
			} catch {}
		}
		await db
			.update(OrganizationLocation)
			.set({
				name: JSON.stringify({ en: locEnName, ar: arName }),
				...(addressPatch ? { address: addressPatch } : {}),
			})
			.where(eq(OrganizationLocation.id, loc.id))
	}
	console.log(
		`✅ Updated ${updatedLocations.length} locations with Arabic names and addresses`,
	)

	// 3. Update Menus
	const menus = await db
		.select()
		.from(OrganizationMenu)
		.where(eq(OrganizationMenu.organizationId, org.id))

	for (const menu of menus) {
		await db
			.update(OrganizationMenu)
			.set({
				displayName: JSON.stringify({
					en: 'Main All-Day Menu',
					ar: 'قائمة الطعام طوال اليوم',
				}),
			})
			.where(eq(OrganizationMenu.id, menu.id))
	}
	console.log(`✅ Updated ${menus.length} menus with Arabic display names`)

	// 4. Update Categories
	const categories = await db
		.select()
		.from(OrganizationMenuCategory)
		.where(eq(OrganizationMenuCategory.organizationId, org.id))

	for (const cat of categories) {
		const raw = cat.displayName
		if (raw.includes('Pizza') || cat.internalName?.includes('pizza')) {
			await db
				.update(OrganizationMenuCategory)
				.set({
					displayName: JSON.stringify({
						en: 'Artisan Pizzas',
						ar: 'بيتزا حرفية',
					}),
					description: JSON.stringify({
						en: 'Handcrafted sourdough pizzas baked at 900°F in our stone wood-fired oven.',
						ar: 'بيتزا مصنوعة يدويًا من العجين المخمر ومخبوزة على حرارة 900 درجة في فرن الحطب الحجري.',
					}),
				})
				.where(eq(OrganizationMenuCategory.id, cat.id))
		} else {
			await db
				.update(OrganizationMenuCategory)
				.set({
					displayName: JSON.stringify({
						en: 'Beverages & Desserts',
						ar: 'المشروبات والحلويات',
					}),
					description: JSON.stringify({
						en: 'Chilled sparkling Italian sodas and decadent house-made desserts.',
						ar: 'مشروبات صودا إيطالية فوارة ومثلجة وحلويات منزلية فاخرة.',
					}),
				})
				.where(eq(OrganizationMenuCategory.id, cat.id))
		}
	}
	console.log(
		`✅ Updated ${categories.length} categories with Arabic translations`,
	)

	// 5. Update Modifier Groups
	const groups = await db
		.select()
		.from(OrganizationMenuModifierGroup)
		.where(eq(OrganizationMenuModifierGroup.organizationId, org.id))

	for (const grp of groups) {
		if (grp.name.includes('Crust') || grp.internalName?.includes('crust')) {
			await db
				.update(OrganizationMenuModifierGroup)
				.set({
					name: JSON.stringify({
						en: 'Choice of Crust',
						ar: 'اختيار العجينة',
					}),
				})
				.where(eq(OrganizationMenuModifierGroup.id, grp.id))
		} else {
			await db
				.update(OrganizationMenuModifierGroup)
				.set({
					name: JSON.stringify({
						en: 'Extra Gourmet Toppings',
						ar: 'إضافات مميزة',
					}),
				})
				.where(eq(OrganizationMenuModifierGroup.id, grp.id))
		}
	}
	console.log(
		`✅ Updated ${groups.length} modifier groups with Arabic translations`,
	)

	// 6. Update Options
	const options = await db
		.select()
		.from(OrganizationMenuOption)
		.where(eq(OrganizationMenuOption.organizationId, org.id))

	for (const opt of options) {
		const name = opt.displayName
		if (name.includes('Thin') || opt.internalName?.includes('thin')) {
			await db
				.update(OrganizationMenuOption)
				.set({
					displayName: JSON.stringify({
						en: 'Neapolitan Thin Crust',
						ar: 'عجينة نابولية رقيقة',
					}),
					description: JSON.stringify({
						en: 'Naturally fermented 48h sourdough crust with blistered cornicione.',
						ar: 'عجينة مخمرة طبيعيًا لمدة 48 ساعة مع حواف مقرمشة ومحمرة.',
					}),
				})
				.where(eq(OrganizationMenuOption.id, opt.id))
		} else if (name.includes('Gluten') || opt.internalName?.includes('gf')) {
			await db
				.update(OrganizationMenuOption)
				.set({
					displayName: JSON.stringify({
						en: 'Gluten-Free Cauliflower Crust',
						ar: 'عجينة خالية من الغلوتين',
					}),
					description: JSON.stringify({
						en: 'Crispy certified gluten-free crust crafted with cauliflower and rice flour.',
						ar: 'عجينة مقرمشة معتمدة خالية من الغلوتين مصنوعة من القرنبيط ودقيق الأرز.',
					}),
				})
				.where(eq(OrganizationMenuOption.id, opt.id))
		} else if (name.includes('Buffalo') || opt.internalName?.includes('mozz')) {
			await db
				.update(OrganizationMenuOption)
				.set({
					displayName: JSON.stringify({
						en: 'Fresh Buffalo Mozzarella',
						ar: 'موزاريلا بوفالو طازجة',
					}),
					description: JSON.stringify({
						en: 'Imported Campana D.O.P. creamy buffalo mozzarella.',
						ar: 'جبنة موزاريلا بوفالو كريمية مستوردة من كامبانيا د.أو.بي.',
					}),
				})
				.where(eq(OrganizationMenuOption.id, opt.id))
		} else if (
			name.includes('Prosciutto') ||
			opt.internalName?.includes('prosciutto')
		) {
			await db
				.update(OrganizationMenuOption)
				.set({
					displayName: JSON.stringify({
						en: 'Prosciutto di Parma 24-Mo',
						ar: 'بروشوتو دي بارما معتق',
					}),
					description: JSON.stringify({
						en: 'Aged 24 months, sliced paper-thin and draped fresh after baking.',
						ar: 'معتق لمدة 24 شهرًا، مقطع إلى شرائح رقيقة كالحرير ويوضع طازجًا بعد الخبز.',
					}),
				})
				.where(eq(OrganizationMenuOption.id, opt.id))
		}
	}
	console.log(`✅ Updated ${options.length} options with Arabic translations`)

	// 7. Update Items
	const items = await db
		.select()
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, org.id))

	for (const item of items) {
		const name = item.displayName
		if (
			name.includes('Margherita') ||
			item.internalName?.includes('margherita')
		) {
			await db
				.update(OrganizationMenuItem)
				.set({
					displayName: JSON.stringify({
						en: 'Margherita D.O.P.',
						ar: 'مارغريتا د.أو.بي',
					}),
					description: JSON.stringify({
						en: 'San Marzano tomatoes, fior di latte, fresh basil leaves, sea salt, and extra virgin olive oil.',
						ar: 'طماطم سان مارزانو، فيور دي لاتي، أوراق ريحان طازجة، ملح بحري، وزيت زيتون بكر ممتاز.',
					}),
				})
				.where(eq(OrganizationMenuItem.id, item.id))
		} else if (
			name.includes('Tartufo') ||
			item.internalName?.includes('mushroom') ||
			item.internalName?.includes('tartufo')
		) {
			await db
				.update(OrganizationMenuItem)
				.set({
					displayName: JSON.stringify({
						en: 'Tartufo & Forest Mushroom',
						ar: 'تارتوفو وفطر الغابة',
					}),
					description: JSON.stringify({
						en: 'Black truffle crema, sautéed cremini and chanterelles, fontina cheese, fresh thyme.',
						ar: 'كريمة الكمأة السوداء، فطر كريميني وشانتيريل سوتيه، جبنة فونتينا، وزعتر طازج.',
					}),
				})
				.where(eq(OrganizationMenuItem.id, item.id))
		} else if (
			name.includes('Pellegrino') ||
			item.internalName?.includes('pellegrino')
		) {
			await db
				.update(OrganizationMenuItem)
				.set({
					displayName: JSON.stringify({
						en: 'San Pellegrino Aranciata',
						ar: 'سان بيليغرينو أرانتشاتا',
					}),
					description: JSON.stringify({
						en: 'Crisp, sparkling Italian orange beverage served over ice with fresh citrus wedge.',
						ar: 'مشروب برتقال إيطالي فوار ومنعش يُقدَّم مع الثلج وشريحة حمضيات طازجة.',
					}),
				})
				.where(eq(OrganizationMenuItem.id, item.id))
		} else if (
			name.includes('Tiramisu') ||
			item.internalName?.includes('tiramisu')
		) {
			await db
				.update(OrganizationMenuItem)
				.set({
					displayName: JSON.stringify({
						en: 'Traditional Venetian Tiramisu',
						ar: 'تيراميسو البندقية التقليدي',
					}),
					description: JSON.stringify({
						en: 'Savoiardi ladyfingers soaked in espresso, mascarpone zabaglione, and Valrhona dark cocoa.',
						ar: 'بسكويت أصابع الست سافوياردي منقوع في الإسبريسو، سابايون الماسكاربوني، وكاكاو فالرونا الداكن.',
					}),
				})
				.where(eq(OrganizationMenuItem.id, item.id))
		}
	}
	console.log(`✅ Updated ${items.length} items with Arabic translations`)

	console.log('🎉 Successfully localized all restaurant entities for acme!')
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})
