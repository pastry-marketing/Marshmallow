/// <reference types="vite/client" />

/**
 * The Google Apps Script mirror lives as a real .gs file so it is versioned,
 * reviewable and syntax-checkable, and is imported as raw text rather than
 * being embedded in a template literal where escapes and drift go unnoticed.
 */
declare module "*.gs?raw" {
  const content: string;
  export default content;
}
