/**
 * Writes every ```ts / ```typescript block in Hera's docs to `snippets/` as its own module, so
 * `bun check -p test/consumers/docs` compiles the examples against src. A block whose
 * fence carries `no-check` (```ts no-check) is an anti-pattern or fragment and is skipped.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "../../..")
const outDir = resolve(import.meta.dirname, "snippets")

function markdownFiles(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.name.endsWith(".md") ? [path] : []
  })
}

const sources = [
  resolve(repoRoot, "README.md"),
  ...markdownFiles(resolve(repoRoot, "docs")),
  ...markdownFiles(resolve(repoRoot, "skills")),
]

const FENCE = /^```(ts|typescript)([^\n]*)\n([\s\S]*?)^```/gm

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

let written = 0
for (const source of sources) {
  const text = readFileSync(source, "utf8")
  const stem = relative(repoRoot, source).replace(/\.md$/, "").replace(/[^A-Za-z0-9]+/g, "_")
  let index = 0
  for (const match of text.matchAll(FENCE)) {
    index += 1
    if ((match[2] ?? "").includes("no-check")) continue
    const line = text.slice(0, match.index).split("\n").length
    const header = `// ${relative(repoRoot, source)}:${line}\n`
    writeFileSync(join(outDir, `${stem}_${index}.ts`), `${header}${match[3]}\nexport {}\n`)
    written += 1
  }
}

console.log(`extract: ${written} snippet(s) from ${sources.length} file(s) -> ${basename(outDir)}/`)
