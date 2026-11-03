// Weight tokens for `fontVariationSettings`. This app ships Geist Variable,
// which has a `wght` axis and no `opsz` axis, so unlike the Inter version of
// these tokens there is no optical-size compensation: the ghost-span pattern
// (see `WeightLabel`) is what keeps a heavier label from reflowing its row.
//
// Text uses three weights: `normal` for text, `semibold` for headings and
// selected items, `bold` for display only.
export const fontWeights = {
	normal: "'wght' 400",
	semibold: "'wght' 550",
	bold: "'wght' 700",
} as const
