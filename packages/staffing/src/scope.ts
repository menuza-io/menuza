/**
 * The one scope every organization has by default.
 *
 * A scope is an opaque id for "the part of the business" staff work at. The
 * generic module gives each organization exactly one, `main`; a vertical that
 * has several (sites, branches, departments) maps its own ids onto this
 * column. Tenant tables keep the id as plain text with no foreign key, so a
 * vertical can introduce its own ids later without a migration.
 */
export const DEFAULT_SCOPE_ID = 'main'
