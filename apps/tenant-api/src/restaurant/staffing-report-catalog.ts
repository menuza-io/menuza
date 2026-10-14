import {
	type ReportCatalog,
	organizationCatalog,
	withScopeWording,
} from '@repo/reports'
import { getOrderSource } from '../services/order-source.ts'

/**
 * The organization report catalog re-worded for a restaurant, where a scope is
 * a location ("Location" instead of "Workplace"). Only labels and descriptions
 * change; field ids are untouched, so saved reports keep working.
 */
export const restaurantReportCatalog: ReportCatalog = {
	...organizationCatalog,
	subjects: withScopeWording(organizationCatalog.subjects, 'location'),
}

/** The catalog this runtime reports on: restaurant wording when an order source is registered. */
export function activeReportCatalog(): ReportCatalog {
	return getOrderSource() ? restaurantReportCatalog : organizationCatalog
}
