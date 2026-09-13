import { faker } from '@faker-js/faker'
import {
	asc,
	and,
	count,
	db,
	eq,
	isNull,
	Organization,
	OrganizationRole,
	User,
	UserOrganization,
	WebsitePage,
	WebsitePageSection,
} from './db.server'

type WebsitePageSectionSeed = {
	type: string
	position: number
	config: string
}

async function createWebsitePage(data: {
	organizationId: string
	title: string
	slug: string
	status: string
	template: string
	isHomePage?: boolean
	position: number
	createdById: string
	sections: WebsitePageSectionSeed[]
}) {
	const [page] = await db
		.insert(WebsitePage)
		.values({
			organizationId: data.organizationId,
			title: data.title,
			slug: data.slug,
			status: data.status,
			template: data.template,
			isHomePage: data.isHomePage,
			position: data.position,
			createdById: data.createdById,
		})
		.returning({ id: WebsitePage.id })

	if (!page) throw new Error(`Failed to create website page: ${data.slug}`)

	await db.insert(WebsitePageSection).values(
		data.sections.map((section) => ({
			pageId: page.id,
			type: section.type,
			position: section.position,
			config: section.config,
		})),
	)
}

async function seedOrganizations() {
	console.log('🏢 Seeding organizations...')
	console.time(`🏢 Organizations have been seeded`)

	// Get existing users
	const users = await db.select({ id: User.id }).from(User).limit(5)

	if (!users.length) {
		console.log('No users found to assign to organizations')
		return
	}

	const [adminRole] = await db
		.select({ id: OrganizationRole.id })
		.from(OrganizationRole)
		.where(
			and(
				eq(OrganizationRole.name, 'admin'),
				isNull(OrganizationRole.organizationId),
			),
		)
		.limit(1)
	const [memberRole] = await db
		.select({ id: OrganizationRole.id })
		.from(OrganizationRole)
		.where(
			and(
				eq(OrganizationRole.name, 'member'),
				isNull(OrganizationRole.organizationId),
			),
		)
		.limit(1)

	if (!adminRole || !memberRole) {
		throw new Error('Organization roles have not been initialized')
	}

	// Create organizations
	const orgCount = 3
	for (let i = 0; i < orgCount; i++) {
		const name = faker.company.name()
		// Create a unique slug
		const baseSlug = name
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '-')
			.replace(/-+/g, '-')
		const slug = `${baseSlug}-${faker.string.alphanumeric(4)}`

		try {
			// Delete organization if it exists (for demo purposes)
			const [existingOrg] = await db
				.select({ id: Organization.id })
				.from(Organization)
				.where(eq(Organization.slug, slug))
				.limit(1)

			if (existingOrg) {
				await db.delete(Organization).where(eq(Organization.id, existingOrg.id))
			}

			const [organization] = await db
				.insert(Organization)
				.values({
					name,
					slug,
					description: faker.company.catchPhrase(),
					active: true,
				})
				.returning({ id: Organization.id, name: Organization.name })

			if (!organization) throw new Error('Failed to create organization')

			console.log(`Created organization: ${organization.name}`)

			// Assign random users as members
			const adminUser = users[0] // First user is admin
			const memberUsers = users.slice(1) // Rest are regular members

			if (adminUser) {
				// Add admin user
				await db.insert(UserOrganization).values({
					userId: adminUser.id,
					organizationId: organization.id,
					organizationRoleId: adminRole.id,
					isDefault: i === 0, // First org is default for admin
				})
			}

			// Add some members
			for (const user of memberUsers) {
				if (Math.random() > 0.3) {
					// 70% chance to add each user
					await db.insert(UserOrganization).values({
						userId: user.id,
						organizationId: organization.id,
						organizationRoleId:
							Math.random() > 0.7 ? adminRole.id : memberRole.id,
						isDefault: false,
					})
				}
			}
		} catch (error) {
			console.error(`Error creating organization: ${error}`)
		}
	}

	// Ensure each user has a default organization
	for (const user of users) {
		const userOrgs = await db
			.select({
				organizationId: UserOrganization.organizationId,
				isDefault: UserOrganization.isDefault,
			})
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, user.id))
			.orderBy(asc(UserOrganization.createdAt))

		if (userOrgs.length > 0 && !userOrgs.some((org) => org.isDefault)) {
			await db
				.update(UserOrganization)
				.set({ isDefault: true })
				.where(
					and(
						eq(UserOrganization.userId, user.id),
						eq(UserOrganization.organizationId, userOrgs[0]!.organizationId),
					),
				)
		}
	}

	console.timeEnd(`🏢 Organizations have been seeded`)
}

async function seedWebsitePages() {
	console.log('📄 Seeding website pages...')
	console.time('📄 Website pages have been seeded')

	const organizations = await db
		.select({ id: Organization.id, name: Organization.name })
		.from(Organization)

	const users = await db.select({ id: User.id }).from(User).limit(1)

	const creatorId = users[0]?.id
	if (!creatorId) {
		console.log('No users found to assign as page creators')
		return
	}

	for (const org of organizations) {
		// Skip if pages already exist
		const [pageCount] = await db
			.select({ existingPages: count() })
			.from(WebsitePage)
			.where(eq(WebsitePage.organizationId, org.id))
		if ((pageCount?.existingPages ?? 0) > 0) continue

		try {
			const siteHeaderConfig = JSON.stringify({
				navLinks: [],
				ctaLabel: 'Get started',
				ctaUrl: '/login',
				showCta: true,
				showName: true,
				sticky: true,
			})
			const siteFooterConfig = JSON.stringify({
				columns: [
					{
						title: 'Explore',
						links: [{ label: 'Home', url: '/' }],
					},
				],
				ctaLabel: 'Get started',
				ctaUrl: '/login',
				showCta: true,
				socials: [],
				copyright: '',
			})

			await db
				.update(Organization)
				.set({ siteHeaderConfig, siteFooterConfig })
				.where(eq(Organization.id, org.id))

			// Home page
			await createWebsitePage({
				organizationId: org.id,
				title: 'Home',
				slug: 'home',
				status: 'published',
				template: 'showcase',
				isHomePage: true,
				position: 0,
				createdById: creatorId,
				sections: [
					{
						type: 'hero',
						position: 0,
						config: JSON.stringify({
							heading: `Welcome to ${org.name}`,
							subheading: `Discover a better way to connect, decide, and get started with ${org.name}.`,
							links: [{ url: '/login', link: { label: 'Get started' } }],
							assetType: 'none',
							assetPosition: 'background',
							textPosition: 'center',
							overlay: 'none',
							minHeight: 640,
							imageUrl: '',
							videoSrc: '',
							videoAutoPlay: true,
							videoLoop: true,
							videoMuted: true,
							videoControls: false,
						}),
					},
					{
						type: 'features',
						position: 1,
						config: JSON.stringify({
							title: 'Everything visitors need to choose you with confidence',
							subtitle:
								'Highlight the outcomes, trust signals, and simple next steps that turn first-time visitors into loyal customers.',
							items: [
								{
									title: 'A clear promise',
									description:
										'Tell people what you do, who you help, and why it matters in seconds.',
								},
								{
									title: 'Friction-free next steps',
									description:
										'Guide visitors toward booking, signing in, or reaching out without making them search.',
								},
								{
									title: 'Built-in credibility',
									description:
										'Use proof points, answers, and testimonials to make every decision feel easy.',
								},
							],
						}),
					},
					{
						type: 'content',
						position: 2,
						config: JSON.stringify({
							title: `Why ${org.name} stands out`,
							subtitle: 'Designed around your customers',
							body: `${org.name} brings helpful information, practical guidance, and a smooth digital experience together in one place. Visitors can understand what makes your work valuable, feel confident about what to expect, and take the next step without friction.\n\nEvery detail is designed to make the path from interest to action feel clear, trustworthy, and easy.`,
							layout: 'text',
							imageUrl: '',
							imageAlt: '',
							imagePosition: 'left',
							imageShape: 'rounded',
							background: 'muted',
							ctaLabel: 'Get started',
							ctaUrl: '/login',
						}),
					},
					{
						type: 'cards',
						position: 3,
						config: JSON.stringify({
							title: 'How it works',
							items: [
								{
									title: 'Explore what matters',
									description:
										'Introduce your services, offers, or resources in a way visitors can understand quickly.',
									imageUrl: '',
									linkUrl: '',
									ctaLabel: 'Step 1',
								},
								{
									title: 'Choose the right path',
									description:
										'Help people compare options, answer common questions, and feel ready to move forward.',
									imageUrl: '',
									linkUrl: '',
									ctaLabel: 'Step 2',
								},
								{
									title: 'Take action with ease',
									description:
										'Send visitors to the next step with a focused call to action and a reassuring experience.',
									imageUrl: '',
									linkUrl: '/login',
									ctaLabel: 'Get started',
								},
							],
						}),
					},
					{
						type: 'testimonials',
						position: 4,
						config: JSON.stringify({
							title: 'Customers feel the difference',
							subtitle:
								'Use social proof to reinforce the promise you make at the top of the page.',
							items: [
								{
									quote:
										'The experience was clear, thoughtful, and easy from the first click.',
									name: 'Alex Rivera',
									rating: 5,
								},
								{
									quote:
										'We understood our options quickly and knew exactly what to do next.',
									name: 'Jordan Lee',
									rating: 5,
								},
								{
									quote:
										'Professional, approachable, and refreshingly simple to work with.',
									name: 'Sam Patel',
									rating: 5,
								},
							],
						}),
					},
					{
						type: 'faq',
						position: 5,
						config: JSON.stringify({
							title: 'Questions before you begin?',
							subtitle:
								'Answer the concerns that usually slow people down right before they take action.',
							items: [
								{
									question: 'What can I do on this site?',
									answer:
										'You can learn what the organization offers, understand the next steps, and access your customer account when you are ready.',
								},
								{
									question: 'How do I get started?',
									answer:
										'Use the call to action on this page to sign in or continue with the next step provided by the organization.',
								},
								{
									question: 'What happens after I get started?',
									answer:
										'You will be guided through the next step with the information and support you need to continue confidently.',
								},
							],
						}),
					},
					{
						type: 'cta',
						position: 6,
						config: JSON.stringify({
							heading: `Ready to experience ${org.name}?`,
							description:
								'Make the next step obvious, reassuring, and easy for every visitor who reaches the end of the page.',
							variant: 'solid',
							imageUrl: '',
							cardPosition: 'center',
							primaryLabel: 'Get started',
							primaryUrl: '/login',
							secondaryLabel: '',
							secondaryUrl: '',
						}),
					},
				],
			})

			// About Us page
			await createWebsitePage({
				organizationId: org.id,
				title: 'About Us',
				slug: 'about',
				status: 'published',
				template: 'article',
				position: 1,
				createdById: creatorId,
				sections: [
					{
						type: 'hero',
						position: 0,
						config: JSON.stringify({
							heading: `About ${org.name}`,
							subheading: 'Our story, mission, and values',
							links: [],
							assetType: 'image',
							assetPosition: 'background',
							textPosition: 'left',
							overlay: 'dark',
							minHeight: 420,
							imageUrl: '',
						}),
					},
					{
						type: 'content',
						position: 1,
						config: JSON.stringify({
							title: 'Our Mission',
							subtitle: '',
							body: `${org.name} was founded with a simple mission: to deliver exceptional value to our customers through innovation, quality, and dedication. We believe that every business deserves access to world-class tools and support.\n\nOur team of passionate professionals works tirelessly to ensure that our products and services exceed expectations. We are committed to continuous improvement and staying at the forefront of industry trends.`,
							layout: 'split',
							imagePosition: 'right',
							imageShape: 'rounded',
						}),
					},
				],
			})

			// FAQ page (draft)
			await createWebsitePage({
				organizationId: org.id,
				title: 'FAQ',
				slug: 'faq',
				status: 'draft',
				template: 'article',
				position: 2,
				createdById: creatorId,
				sections: [
					{
						type: 'hero',
						position: 0,
						config: JSON.stringify({
							heading: 'Frequently Asked Questions',
							subheading: 'Find answers to common questions',
							links: [],
							assetType: 'none',
							textPosition: 'center',
							overlay: 'none',
							minHeight: 280,
						}),
					},
					{
						type: 'faq',
						position: 1,
						config: JSON.stringify({
							title: 'Common Questions',
							subtitle: '',
							items: [
								{
									question: 'How do I get started?',
									answer:
										'Simply create an account and follow our onboarding guide to get up and running in minutes.',
								},
								{
									question: 'What payment methods do you accept?',
									answer:
										'We accept all major credit cards, PayPal, and bank transfers for enterprise accounts.',
								},
								{
									question: 'Can I cancel my subscription?',
									answer:
										'Yes, you can cancel your subscription at any time from your account settings. No questions asked.',
								},
								{
									question: 'Do you offer customer support?',
									answer:
										'Absolutely! Our support team is available 24/7 via email, chat, and phone.',
								},
							],
						}),
					},
				],
			})

			console.log(`  Created website pages for: ${org.name}`)
		} catch (error) {
			console.error(`  Error creating pages for ${org.name}: ${error}`)
		}
	}

	console.timeEnd('📄 Website pages have been seeded')
}

seedOrganizations()
	.then(() => seedWebsitePages())
	.catch((e) => {
		console.error(e)
		process.exit(1)
	})
