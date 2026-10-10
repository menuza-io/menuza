import { type ReportScope, getCatalog } from './catalog.ts'
import {
	type FilterCondition,
	type Measure,
	type ReportDefinition,
	createReportDefinition,
	emptyFilterGroup,
} from './dsl.ts'

export type ReportTemplate = {
	id: string
	category: string
	title: string
	description: string
	scope: ReportScope
	definition: ReportDefinition
}

function template(
	scope: ReportScope,
	input: Omit<ReportTemplate, 'scope' | 'definition'> & {
		subject: string
		groupBy: string[]
		chartStyle: ReportDefinition['visualization']['chartStyle']
		timeframePreset?: ReportDefinition['timeframe']['preset']
		timeframeField?: string
		timeBucket?: ReportDefinition['timeBucket']
		columns?: string[]
		sortBy?: ReportDefinition['visualization']['sortBy']
		measure?: Measure
		/** Number or currency field a sum or average reads. */
		valueField?: string
		/** Conditions that must all match. */
		filters?: FilterCondition[]
		title?: string
	},
): ReportTemplate {
	const catalog = getCatalog(scope)
	const subject = catalog.subjects.find((item) => item.id === input.subject)
	if (!subject) {
		throw new Error(`Unknown template subject: ${input.subject}`)
	}
	const timeframeField =
		input.timeframeField ??
		subject.fields.find((field) => field.timeframe)?.id ??
		'createdAt'

	return {
		id: input.id,
		category: input.category,
		title: input.title,
		description: input.description,
		scope,
		definition: createReportDefinition({
			subject: input.subject,
			timeframe: {
				field: timeframeField,
				preset: input.timeframePreset ?? 'last_3_months',
			},
			groupBy: input.groupBy,
			timeBucket: input.timeBucket ?? 'month',
			columns: input.columns ?? [],
			filters: input.filters?.length
				? { combinator: 'and', conditions: input.filters }
				: emptyFilterGroup(),
			visualization: {
				chartStyle: input.chartStyle,
				measure: input.measure ?? 'count',
				...(input.valueField ? { valueField: input.valueField } : {}),
				sortBy: input.sortBy ?? 'value_desc',
				hideCounts: false,
			},
			settings: {
				title: input.title,
				notes: input.description,
				timezone: 'user',
			},
		}),
	}
}

/** Orders that count toward sales; see the `countsTowardSales` field. */
const COUNTED_ORDERS: FilterCondition[] = [
	{ field: 'countsTowardSales', operator: 'eq', value: 'true' },
]

function salesTemplates(): ReportTemplate[] {
	const sales = {
		category: 'Sales',
		subject: 'orders',
		filters: COUNTED_ORDERS,
	} as const
	return [
		template('organization', {
			...sales,
			id: 'sales-total',
			title: 'Total sales',
			description:
				'Order totals, including tax, delivery fees, and tips, from orders that count toward sales.',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'sum',
			valueField: 'total',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			...sales,
			id: 'sales-by-month',
			title: 'Sales by month',
			description: 'Sales month by month over the last year.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'total',
			timeBucket: 'month',
			timeframePreset: 'last_12_months',
			sortBy: 'none',
		}),
		template('organization', {
			...sales,
			id: 'sales-by-week',
			title: 'Sales by week',
			description: 'Sales week by week over the last 3 months.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'total',
			timeBucket: 'week',
			sortBy: 'none',
		}),
		template('organization', {
			...sales,
			id: 'sales-by-location',
			title: 'Sales by location',
			description: 'Compare sales across your locations.',
			groupBy: ['location'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'total',
		}),
		template('organization', {
			...sales,
			id: 'sales-by-fulfillment',
			title: 'Pickup vs delivery sales',
			description: 'Sales split between pickup and delivery orders.',
			groupBy: ['fulfillment'],
			chartStyle: 'pie',
			measure: 'sum',
			valueField: 'total',
		}),
		template('organization', {
			...sales,
			id: 'sales-by-source',
			title: 'Menu vs drop sales',
			description: 'Sales from your regular menu compared with drops.',
			groupBy: ['source'],
			chartStyle: 'pie',
			measure: 'sum',
			valueField: 'total',
		}),
		template('organization', {
			...sales,
			id: 'sales-attributed',
			title: 'Sales from email and texts',
			description:
				'Sales from orders placed within 7 days of receiving one of your emails or texts.',
			groupBy: ['attributedChannel'],
			chartStyle: 'pie',
			measure: 'sum',
			valueField: 'total',
		}),
		template('organization', {
			...sales,
			id: 'average-order-value',
			title: 'Average order value',
			description:
				'The average order total, including tax, delivery fees, and tips.',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'average',
			valueField: 'total',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			...sales,
			id: 'average-order-value-by-month',
			title: 'Average order value by month',
			description: 'How the average order total changes month to month.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			measure: 'average',
			valueField: 'total',
			timeBucket: 'month',
			timeframePreset: 'last_12_months',
			sortBy: 'none',
		}),
		template('organization', {
			...sales,
			id: 'tips-total',
			title: 'Tips',
			description: 'Tips customers added at checkout.',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'sum',
			valueField: 'tip',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			...sales,
			id: 'tips-by-month',
			title: 'Tips by month',
			description: 'Tips month by month over the last year.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'tip',
			timeBucket: 'month',
			timeframePreset: 'last_12_months',
			sortBy: 'none',
		}),
		template('organization', {
			...sales,
			id: 'tips-average-percent',
			title: 'Average tip percent',
			description:
				'The average tip as a percent of the order subtotal. Orders without a tip count as 0%.',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'average',
			valueField: 'tipPercent',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			...sales,
			id: 'taxes-total',
			title: 'Taxes collected',
			description: 'Sales tax charged on orders that count toward sales.',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'sum',
			valueField: 'tax',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			...sales,
			id: 'taxes-by-month',
			title: 'Taxes by month',
			description: 'Sales tax month by month over the last year.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'tax',
			timeBucket: 'month',
			timeframePreset: 'last_12_months',
			sortBy: 'none',
		}),
		template('organization', {
			...sales,
			id: 'delivery-fees',
			title: 'Delivery fees',
			description: 'Delivery fees charged on orders that count toward sales.',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'sum',
			valueField: 'deliveryFee',
			timeframePreset: 'last_30_days',
		}),
	]
}

function orderTemplates(): ReportTemplate[] {
	const orders = { category: 'Orders', subject: 'orders' } as const
	return [
		template('organization', {
			...orders,
			id: 'orders-total',
			title: 'Total orders',
			description:
				'Open and completed orders, once online payment has gone through.',
			groupBy: [],
			chartStyle: 'single_number',
			filters: COUNTED_ORDERS,
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			...orders,
			id: 'orders-by-month',
			title: 'Orders by month',
			description: 'Orders that count toward sales, month by month.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			filters: COUNTED_ORDERS,
			timeBucket: 'month',
			timeframePreset: 'last_12_months',
			sortBy: 'none',
		}),
		template('organization', {
			...orders,
			id: 'orders-by-week',
			title: 'Orders by week',
			description: 'Orders that count toward sales, week by week.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			filters: COUNTED_ORDERS,
			timeBucket: 'week',
			sortBy: 'none',
		}),
		template('organization', {
			...orders,
			id: 'orders-by-status',
			title: 'Orders by status',
			description:
				'Every order placed, including cancelled, expired, and unpaid ones.',
			groupBy: ['status'],
			chartStyle: 'pie',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			...orders,
			id: 'orders-by-fulfillment',
			title: 'Pickup vs delivery',
			description: 'Orders split between pickup and delivery.',
			groupBy: ['fulfillment'],
			chartStyle: 'pie',
			filters: COUNTED_ORDERS,
		}),
		template('organization', {
			...orders,
			id: 'orders-by-location',
			title: 'Orders by location',
			description: 'Compare order counts across your locations.',
			groupBy: ['location'],
			chartStyle: 'bar',
			filters: COUNTED_ORDERS,
		}),
		template('organization', {
			...orders,
			id: 'orders-by-source',
			title: 'Orders by source',
			description: 'Orders from your regular menu compared with drops.',
			groupBy: ['source'],
			chartStyle: 'pie',
			filters: COUNTED_ORDERS,
		}),
		template('organization', {
			...orders,
			id: 'orders-new-vs-returning',
			title: 'First-time vs returning',
			description:
				'Orders from first-time customers compared with customers who ordered before, matched by account or phone number.',
			groupBy: ['customerType'],
			chartStyle: 'pie',
			filters: COUNTED_ORDERS,
		}),
		template('organization', {
			...orders,
			id: 'orders-by-timing',
			title: 'ASAP vs scheduled',
			description:
				'Orders placed for as soon as possible compared with orders scheduled ahead.',
			groupBy: ['timing'],
			chartStyle: 'pie',
			filters: COUNTED_ORDERS,
		}),
		template('organization', {
			...orders,
			id: 'orders-by-payment-method',
			title: 'Online vs pay at handoff',
			description: 'How customers chose to pay for their orders.',
			groupBy: ['paymentMethod'],
			chartStyle: 'pie',
			filters: COUNTED_ORDERS,
		}),
		template('organization', {
			...orders,
			id: 'order-list',
			title: 'Order list',
			description:
				'Explore recent orders with customer, status, fulfillment, and total.',
			groupBy: [],
			chartStyle: 'table',
			columns: [
				'orderNumber',
				'customerName',
				'status',
				'fulfillment',
				'total',
				'createdAt',
			],
			timeframePreset: 'last_30_days',
			sortBy: 'none',
		}),
	]
}

function menuTemplates(): ReportTemplate[] {
	return [
		template('organization', {
			id: 'items-top-sellers',
			category: 'Menu',
			title: 'Top-selling items',
			description: 'Menu items ranked by how many were sold.',
			subject: 'order_items',
			groupBy: ['itemName'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'quantity',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'items-sales',
			category: 'Menu',
			title: 'Item sales',
			description:
				'Sales for each menu item, including option charges, before tax and tips.',
			subject: 'order_items',
			groupBy: ['itemName'],
			chartStyle: 'table',
			measure: 'sum',
			valueField: 'sales',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'options-top',
			category: 'Menu',
			title: 'Top options',
			description: 'Options and add-ons ranked by how often they were chosen.',
			subject: 'order_options',
			groupBy: ['optionName'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'quantity',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'option-group-sales',
			category: 'Menu',
			title: 'Option group sales',
			description:
				'Extra charges from each option group, such as sizes or toppings.',
			subject: 'order_options',
			groupBy: ['groupName'],
			chartStyle: 'table',
			measure: 'sum',
			valueField: 'sales',
			timeframePreset: 'last_30_days',
		}),
	]
}

function customerTemplates(): ReportTemplate[] {
	const customers = { category: 'Customers', subject: 'customers' } as const
	return [
		template('organization', {
			...customers,
			id: 'customer-count',
			title: 'Customer count',
			description:
				'A single number of site customers in the selected timeframe.',
			groupBy: [],
			chartStyle: 'single_number',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			...customers,
			id: 'customers-by-month',
			title: 'Customers by month',
			description: 'Count new site customers over the last 3 months.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			timeBucket: 'month',
			sortBy: 'none',
		}),
		template('organization', {
			...customers,
			id: 'customers-by-week',
			title: 'Customers by week',
			description: 'Count new site customers week by week.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			timeBucket: 'week',
			sortBy: 'none',
		}),
		template('organization', {
			...customers,
			id: 'customers-first-order-by-month',
			title: 'New customers by first order',
			description:
				'Signed-in customers, counted in the month they placed their first order.',
			groupBy: ['firstOrderAt'],
			chartStyle: 'bar',
			timeframeField: 'firstOrderAt',
			timeBucket: 'month',
			timeframePreset: 'last_12_months',
			sortBy: 'none',
		}),
		template('organization', {
			...customers,
			id: 'customers-first-order-source',
			title: 'New customers by source',
			description:
				'Whether new customers placed their first order from your menu or a drop.',
			groupBy: ['firstOrderSource'],
			chartStyle: 'pie',
			timeframeField: 'firstOrderAt',
		}),
		template('organization', {
			...customers,
			id: 'customers-ordered',
			title: 'Customers who ordered',
			description:
				'Signed-in customers who placed at least one order that counts toward sales.',
			groupBy: ['hasOrdered'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			...customers,
			id: 'customers-average-spend',
			title: 'Average spend per customer',
			description:
				'Lifetime order totals per signed-in customer who has ordered.',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'average',
			valueField: 'totalSpent',
			filters: [{ field: 'hasOrdered', operator: 'eq', value: 'true' }],
			timeframePreset: 'all_time',
		}),
		template('organization', {
			...customers,
			id: 'customers-verified',
			title: 'Phone verification',
			description: 'Segment customers by whether their phone is verified.',
			groupBy: ['phoneVerified'],
			chartStyle: 'pie',
		}),
		template('organization', {
			...customers,
			id: 'customer-list',
			title: 'Customer list',
			description:
				'A table of site customers with name, email, phone, and created date.',
			groupBy: [],
			chartStyle: 'table',
			columns: ['name', 'email', 'phone', 'createdAt'],
			timeframePreset: 'all_time',
			sortBy: 'none',
		}),
		template('organization', {
			...customers,
			id: 'customers-recent',
			title: 'Recent customers',
			description:
				'Explore customers by their last order, with order count and total spent.',
			groupBy: [],
			chartStyle: 'table',
			columns: [
				'name',
				'phone',
				'email',
				'orderCount',
				'totalSpent',
				'lastOrderAt',
			],
			timeframeField: 'lastOrderAt',
			timeframePreset: 'last_30_days',
			sortBy: 'none',
		}),
	]
}

function marketingTemplates(): ReportTemplate[] {
	return [
		template('organization', {
			id: 'email-audience',
			category: 'Marketing',
			title: 'Email audience',
			description:
				'Customers with an email address, who your marketing emails can reach.',
			subject: 'customers',
			groupBy: [],
			chartStyle: 'single_number',
			filters: [{ field: 'hasEmail', operator: 'eq', value: 'true' }],
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'email-audience-share',
			category: 'Marketing',
			title: 'Customers with email',
			description: 'Share of customers your marketing emails can reach.',
			subject: 'customers',
			groupBy: ['hasEmail'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'text-subscribers',
			category: 'Marketing',
			title: 'Text subscribers',
			description: 'Customers subscribed to your texts right now.',
			subject: 'text_subscribers',
			groupBy: [],
			chartStyle: 'single_number',
			filters: [{ field: 'status', operator: 'eq', value: 'subscribed' }],
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'text-subscribers-by-month',
			category: 'Marketing',
			title: 'Text sign-ups by month',
			description: 'New text subscribers month by month.',
			subject: 'text_subscribers',
			groupBy: ['subscribedAt'],
			chartStyle: 'bar',
			timeBucket: 'month',
			timeframePreset: 'last_12_months',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'text-subscribers-by-source',
			category: 'Marketing',
			title: 'Text sign-ups by source',
			description: 'Where customers subscribed to your texts.',
			subject: 'text_subscribers',
			groupBy: ['source'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'text-unsubscribes-by-month',
			category: 'Marketing',
			title: 'Text opt-outs by month',
			description: 'Customers who stopped your texts, month by month.',
			subject: 'text_subscribers',
			groupBy: ['unsubscribedAt'],
			chartStyle: 'bar',
			timeframeField: 'unsubscribedAt',
			timeBucket: 'month',
			timeframePreset: 'last_12_months',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'orders-attributed',
			category: 'Marketing',
			title: 'Orders from email and texts',
			description:
				'Orders placed within 7 days of receiving one of your emails or texts.',
			subject: 'orders',
			groupBy: ['attributedChannel'],
			chartStyle: 'pie',
			filters: COUNTED_ORDERS,
		}),
	]
}

function reviewTemplates(): ReportTemplate[] {
	const reviews = {
		category: 'Reviews',
		subject: 'reviews',
		timeframePreset: 'last_12_months',
	} as const
	return [
		template('organization', {
			...reviews,
			id: 'reviews-average-rating',
			title: 'Average rating',
			description: 'Average star rating across your connected review sites.',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'average',
			valueField: 'stars',
		}),
		template('organization', {
			...reviews,
			id: 'reviews-by-rating',
			title: 'Reviews by rating',
			description: 'How many reviews gave each star rating.',
			groupBy: ['rating'],
			chartStyle: 'bar',
			sortBy: 'label',
		}),
		template('organization', {
			...reviews,
			id: 'reviews-by-month',
			title: 'Reviews by month',
			description: 'New reviews month by month.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			timeBucket: 'month',
			sortBy: 'none',
		}),
		template('organization', {
			...reviews,
			id: 'reviews-rating-by-month',
			title: 'Average rating by month',
			description: 'How your average star rating changes month to month.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			measure: 'average',
			valueField: 'stars',
			timeBucket: 'month',
			sortBy: 'none',
		}),
		template('organization', {
			...reviews,
			id: 'reviews-by-site',
			title: 'Reviews by site',
			description: 'Reviews from each connected review site.',
			groupBy: ['provider'],
			chartStyle: 'pie',
		}),
		template('organization', {
			...reviews,
			id: 'reviews-replied',
			title: 'Reply rate',
			description: 'Reviews you replied to compared with ones still waiting.',
			groupBy: ['replied'],
			chartStyle: 'pie',
		}),
		template('organization', {
			...reviews,
			id: 'reviews-list',
			title: 'Recent reviews',
			description: 'A list of recent reviews with site, rating, and reply.',
			groupBy: [],
			chartStyle: 'table',
			columns: [
				'reviewer',
				'provider',
				'rating',
				'location',
				'replied',
				'createdAt',
			],
			timeframePreset: 'last_30_days',
			sortBy: 'none',
		}),
	]
}

export function organizationTemplates(): ReportTemplate[] {
	return [
		...salesTemplates(),
		...orderTemplates(),
		...menuTemplates(),
		...customerTemplates(),
		...marketingTemplates(),
		...reviewTemplates(),
		template('organization', {
			id: 'phone-calls-by-week',
			category: 'Phone calls',
			title: 'Calls by week',
			description: 'Count calls answered by the phone agent week by week.',
			subject: 'phone_calls',
			groupBy: ['startedAt'],
			chartStyle: 'bar',
			timeBucket: 'week',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'phone-calls-by-purpose',
			category: 'Phone calls',
			title: 'Why people call',
			description: 'Calls grouped by why the caller rang.',
			subject: 'phone_calls',
			groupBy: ['purpose'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-by-outcome',
			category: 'Phone calls',
			title: 'Call outcomes',
			description:
				'How calls ended: resolved, link sent, transferred, message, or hung up.',
			subject: 'phone_calls',
			groupBy: ['outcome'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-resolved',
			category: 'Phone calls',
			title: 'Handled without staff',
			description:
				'Share of calls the assistant handled with no transfer or message.',
			subject: 'phone_calls',
			groupBy: ['resolvedByAssistant'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-transfers',
			category: 'Phone calls',
			title: 'Transfers',
			description: 'Transferred calls split by whether staff picked up.',
			subject: 'phone_calls',
			groupBy: ['transferResult'],
			chartStyle: 'bar',
		}),
		template('organization', {
			id: 'phone-calls-open-closed',
			category: 'Phone calls',
			title: 'Calls while open vs closed',
			description: 'How many calls come in outside business hours.',
			subject: 'phone_calls',
			groupBy: ['calledWhileOpen'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-length',
			category: 'Phone calls',
			title: 'Call length',
			description: 'Calls grouped by how long they lasted.',
			subject: 'phone_calls',
			groupBy: ['durationBucket'],
			chartStyle: 'bar',
			sortBy: 'label',
		}),
		template('organization', {
			id: 'phone-calls-repeat',
			category: 'Phone calls',
			title: 'Repeat callers',
			description: 'Calls from numbers that called in the previous 30 days.',
			subject: 'phone_calls',
			groupBy: ['repeatCaller'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-links',
			category: 'Phone calls',
			title: 'Links texted',
			description: 'Calls where the caller got a link by text.',
			subject: 'phone_calls',
			groupBy: ['linkSent'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-ratings',
			category: 'Phone calls',
			title: 'Caller ratings',
			description: 'End-of-call ratings from 1 to 5.',
			subject: 'phone_calls',
			groupBy: ['rating'],
			chartStyle: 'bar',
			sortBy: 'label',
		}),
		template('organization', {
			id: 'phone-calls-follow-up',
			category: 'Phone calls',
			title: 'Calls needing follow-up',
			description: 'A list of calls that still need someone on the team.',
			subject: 'phone_calls',
			groupBy: [],
			chartStyle: 'table',
			columns: [
				'startedAt',
				'callerPhone',
				'purpose',
				'outcome',
				'followUpStatus',
			],
			timeframePreset: 'all_time',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'shop-sales',
			category: 'Shop',
			title: 'Shop sales',
			description: 'Paid purchases from your public site shop.',
			subject: 'shop_orders',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'sum',
			valueField: 'amount',
			filters: [{ field: 'status', operator: 'eq', value: 'paid' }],
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'shop-orders-by-month',
			category: 'Shop',
			title: 'Shop orders by month',
			description: 'Count shop orders over the last 3 months.',
			subject: 'shop_orders',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			timeBucket: 'month',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'shop-orders-by-status',
			category: 'Shop',
			title: 'Shop orders by status',
			description: 'See how shop orders are distributed by payment status.',
			subject: 'shop_orders',
			groupBy: ['status'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'shop-order-list',
			category: 'Shop',
			title: 'Shop order list',
			description:
				'A table of shop orders with customer, product, amount, status, and date.',
			subject: 'shop_orders',
			groupBy: [],
			chartStyle: 'table',
			columns: [
				'customerName',
				'customerPhone',
				'productName',
				'amount',
				'status',
				'createdAt',
			],
			timeframePreset: 'all_time',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'shop-order-count',
			category: 'Shop',
			title: 'Shop order count',
			description: 'A single number of shop orders in the selected timeframe.',
			subject: 'shop_orders',
			groupBy: [],
			chartStyle: 'single_number',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'notes-by-status',
			category: 'Notes',
			title: 'Notes by status',
			description: 'See how notes are distributed across board columns.',
			subject: 'notes',
			groupBy: ['status'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'notes-by-priority',
			category: 'Notes',
			title: 'Notes by priority',
			description: 'Count notes grouped by priority.',
			subject: 'notes',
			groupBy: ['priority'],
			chartStyle: 'bar',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'members-by-role',
			category: 'Team',
			title: 'Members by role',
			description: 'Count operators in this organization by role.',
			subject: 'members',
			groupBy: ['role'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'feedback-by-type',
			category: 'Feedback',
			title: 'Feedback by type',
			description: 'Count in-app feedback submissions by type.',
			subject: 'feedback',
			groupBy: ['type'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
	]
}

export function platformTemplates(): ReportTemplate[] {
	return [
		template('platform', {
			id: 'orgs-by-region',
			category: 'Organizations',
			title: 'Organizations by region',
			description: 'Count tenants by customer data region.',
			subject: 'organizations',
			groupBy: ['dataRegion'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('platform', {
			id: 'orgs-published',
			category: 'Organizations',
			title: 'Published sites',
			description: 'How many organizations have published a public site.',
			subject: 'organizations',
			groupBy: ['sitePublished'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('platform', {
			id: 'users-by-month',
			category: 'Users',
			title: 'New operators by month',
			description: 'Count operator signups over the last 6 months.',
			subject: 'users',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			timeBucket: 'month',
			timeframePreset: 'last_6_months',
			sortBy: 'none',
		}),
		template('platform', {
			id: 'waitlist-access',
			category: 'Waitlist',
			title: 'Waitlist early access',
			description: 'Segment waitlist entries by early-access grant.',
			subject: 'waitlist',
			groupBy: ['hasEarlyAccess'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('platform', {
			id: 'feedback-types',
			category: 'Feedback',
			title: 'Platform feedback',
			description: 'Count feedback across every organization by type.',
			subject: 'feedback',
			groupBy: ['type'],
			chartStyle: 'pie',
		}),
		template('platform', {
			id: 'audit-severity',
			category: 'Security',
			title: 'Audit log severity',
			description: 'Count audit events by severity.',
			subject: 'audit_logs',
			groupBy: ['severity'],
			chartStyle: 'bar',
			timeframePreset: 'last_30_days',
		}),
		template('platform', {
			id: 'user-count',
			category: 'Users',
			title: 'Operator count',
			description: 'Total operator accounts created in the selected timeframe.',
			subject: 'users',
			groupBy: [],
			chartStyle: 'single_number',
			timeframePreset: 'all_time',
		}),
	]
}

export function templatesFor(scope: ReportScope): ReportTemplate[] {
	return scope === 'platform' ? platformTemplates() : organizationTemplates()
}

export function blankReportDefinition(scope: ReportScope): ReportDefinition {
	if (scope === 'platform') {
		return createReportDefinition({
			subject: 'organizations',
			timeframe: { field: 'createdAt', preset: 'all_time' },
			groupBy: ['dataRegion'],
			timeBucket: 'month',
			columns: [],
			filters: emptyFilterGroup(),
			visualization: {
				chartStyle: 'pie',
				measure: 'count',
				sortBy: 'value_desc',
				hideCounts: false,
			},
			settings: {
				title: 'New Report',
				notes: '',
				timezone: 'user',
			},
		})
	}

	return createReportDefinition({
		subject: 'customers',
		timeframe: { field: 'createdAt', preset: 'last_3_months' },
		groupBy: [],
		timeBucket: 'month',
		columns: [],
		filters: emptyFilterGroup(),
		visualization: {
			chartStyle: 'pie',
			measure: 'count',
			sortBy: 'value_desc',
			hideCounts: false,
		},
		settings: {
			title: 'New Report',
			notes: '',
			timezone: 'user',
		},
	})
}

export function definitionForNewReport(
	scope: ReportScope,
	templateId: string | null | undefined,
): ReportDefinition {
	const template = templateId
		? templatesFor(scope).find((item) => item.id === templateId)
		: undefined
	return template?.definition ?? blankReportDefinition(scope)
}

export function templateCategories(templates: ReportTemplate[]): string[] {
	return [...new Set(templates.map((item) => item.category))]
}
