// Markdown files imported as text: inlined by tsup's `.md` text loader (and by the vitest configs' `markdownText` plugin).
declare module "*.md" {
  const text: string;
  export default text;
}
