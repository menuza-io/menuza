import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	type CopyNote,
	type CopySkipReason,
} from '@repo/common/location-settings-copy'
import { type LocationSettingId } from '@repo/common/location-settings-registry'

/** The name of each registry setting as people read it. */
export const SETTING_LABELS: Record<LocationSettingId, MessageDescriptor> = {
	storeHours: msg`Store hours`,
	onlineHours: msg`Online ordering hours`,
	specialHours: msg`Special hours (holidays)`,
	prepTime: msg`Prep time`,
	largeOrder: msg`Large-order rules`,
	fulfillment: msg`Fulfillment options`,
	tips: msg`Tips`,
	scheduling: msg`Scheduled (advance) orders`,
	delivery: msg`Delivery settings (providers and times)`,
	orderCaps: msg`Order size caps`,
	serviceFee: msg`Service fee`,
	packagingFee: msg`Packaging fee`,
}

export const SETTING_DESCRIPTIONS: Record<
	LocationSettingId,
	MessageDescriptor
> = {
	storeHours: msg`The weekly opening hours of the restaurant.`,
	onlineHours: msg`When guests can place online orders.`,
	specialHours: msg`Closed or short days such as holidays.`,
	prepTime: msg`Minutes to get an order ready.`,
	largeOrder: msg`Extra time for large orders.`,
	fulfillment: msg`Pickup, delivery, dine-in and curbside.`,
	tips: msg`Tip buttons at checkout and in-house tips.`,
	scheduling: msg`Whether guests can order ahead and how far.`,
	delivery: msg`Delivery providers and estimated times. Delivery zones are not included.`,
	orderCaps: msg`The largest order a guest can place.`,
	serviceFee: msg`The service fee guests pay at checkout.`,
	packagingFee: msg`The packaging or bag fee.`,
}

export const COPY_NOTE_LABELS: Record<CopyNote, MessageDescriptor> = {
	timezone_differs: msg`Different time zone: the same local times apply (11:00 stays 11:00 there).`,
	online_hours_follow_store: msg`This location's online hours are set to follow its store hours. The copied hours apply until its store hours are changed.`,
}

export const COPY_SKIP_LABELS: Record<CopySkipReason, MessageDescriptor> = {
	currency_differs: msg`Skipped: this location uses a different currency.`,
}

/** Words for the error codes the multi-location actions answer with. */
export const LOCATION_ERROR_LABELS: Record<string, MessageDescriptor> = {
	invalid_request: msg`That request was not valid. Check the form and try again.`,
	location_not_allowed: msg`You do not have access to that location.`,
	source_not_found: msg`The location to copy from was not found.`,
	setting_locked: msg`Head office has locked this setting. Change the chain default instead.`,
	setting_unavailable: msg`This setting is not available for your restaurant yet.`,
	copy_failed: msg`Nothing was changed. Something went wrong, please try again.`,
	not_manageable: msg`You do not manage this location`,
	not_found: msg`Location not found`,
	failed: msg`Could not be changed`,
}
