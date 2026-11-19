/**
 * The wording of one language: flat keys with `{placeholders}`. Every language
 * has exactly the keys of English (`copy.test.ts` checks it), so a document can
 * be generated in any site language.
 */
export type LegalCopy = Record<string, string>
