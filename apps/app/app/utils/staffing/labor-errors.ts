import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type SalesCsvErrorCode } from '@repo/staffing'
import { StaffApiError } from './staff-client.ts'
import { describeStaffError } from './staff-errors.ts'

/**
 * Plain-language answers for the codes the labor API refuses with, and for the
 * lines of a sales file that could not be read. Unknown codes fall back to the
 * general staff messages; raw server text is never shown.
 */
const MESSAGES: Record<string, MessageDescriptor> = {
	future_date: msg`Sales cannot be entered for a day that has not happened yet.`,
	unknown_position: msg`One of those positions no longer exists. Reload and try again.`,
	range_too_large: msg`That range has too many time cards to export. Choose a shorter range.`,
	time_zone_unknown: msg`We could not find this workplace's time zone. Set it in the time clock settings.`,
	forbidden: msg`You do not have permission to do that.`,
}

export function describeLaborError(
	error: unknown,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	if (error instanceof StaffApiError) {
		const known = MESSAGES[error.code]
		if (known) return translate(known)
	}
	return describeStaffError(error, translate)
}

export const CSV_ERROR_MESSAGES: Record<SalesCsvErrorCode, MessageDescriptor> =
	{
		empty: msg`The file is empty.`,
		too_large: msg`The file is too large. Split it into smaller files.`,
		missing_header: msg`The first row should name the columns, for example Date and Net sales.`,
		missing_date_column: msg`There is no Date column.`,
		missing_sales_column: msg`There is no Net sales column.`,
		bad_date: msg`The date could not be read.`,
		bad_amount: msg`The amount could not be read.`,
		negative_amount: msg`Sales cannot be negative.`,
		too_many_decimals: msg`Amounts can have at most two decimal places.`,
		amount_too_large: msg`That amount is too large.`,
		duplicate_date: msg`This date appears more than once in the file.`,
		too_many_rows: msg`The file has more than a year of days. Split it up.`,
		wrong_column_count: msg`This row has a different number of columns than the header.`,
	}
