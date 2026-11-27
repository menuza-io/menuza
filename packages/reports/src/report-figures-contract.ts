import { z } from 'zod'
import { MONTH_KEY, FIGURES, type FigureId } from './summary-figures.ts'
import { reportGrantsSchema } from './report-send-contract.ts'

/**
 * The wire contract of `POST /internal/reports/figures` (#221): the App's
 * monthly results job asks the organization's region for the month's totals,
 * one answer per distinct set of grants (a person only gets the lines their
 * own grants allow). Aggregate numbers only: no guest name, phone or email,
 * and nothing that is not a figure of `summary-figures.ts`.
 */

const REGION_FIGURE_IDS = (Object.keys(FIGURES) as FigureId[]).filter(
	(id) => FIGURES[id].source === 'region',
) as [FigureId, ...FigureId[]]

export const reportFiguresRequestSchema = z.object({
	orgId: z.string().min(1).max(64).regex(/^[\w-]+$/),
	/** `YYYY-MM`: each location's own calendar month in its own zone. */
	month: z.string().regex(MONTH_KEY),
	timeZone: z.string().min(1).max(64),
	groups: z
		.array(
			z.object({
				key: z.string().min(1).max(64),
				grants: reportGrantsSchema,
				figureIds: z.array(z.enum(REGION_FIGURE_IDS)).min(1).max(30),
			}),
		)
		.min(1)
		.max(40),
})
export type ReportFiguresRequest = z.infer<typeof reportFiguresRequestSchema>

const entrySchema = z.object({
	currency: z.string().nullable(),
	value: z.number(),
})

export const reportFiguresResponseSchema = z.object({
	groups: z.array(
		z.object({
			key: z.string(),
			figures: z.array(
				z.object({
					id: z.string(),
					format: z.enum(['currency', 'number', 'percent', 'rating']),
					entries: z.array(entrySchema),
					previous: z.array(entrySchema),
				}),
			),
		}),
	),
})
export type ReportFiguresResponse = z.infer<typeof reportFiguresResponseSchema>
