import { tool, type ToolSet } from 'ai'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { markReadOnly } from './approval.ts'
import { runContext } from './context.ts'
import type { ISkill } from './types.ts'

export const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/

// Built-in tool names (reserved when skills are configured).
export const LOAD_SKILL_TOOL = 'load_skill'
export const READ_SKILL_FILE_TOOL = 'read_skill_file'

// Budget for active skill instructions injected into system prompts.
export const ACTIVE_SKILLS_BUDGET_CHARS = 24_000

const normalizeSkillPath = (p: string): string => {
  const posix = p.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const normalized = path.posix.normalize(posix)
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`skill file path must be relative and stay inside the skill: "${p}"`)
  }
  return normalized
}

/**
 * Validate a skill (name, description, content, files) and return a
 * normalised copy. Throws a descriptive error on anything invalid.
 */
export const defineSkill = (skill: ISkill): ISkill => {
  if (!skill || typeof skill !== 'object') {
    throw new Error('skill must be an object { name, description, content, files? }')
  }
  const { name, description, content, files } = skill
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`skill name must match ${SKILL_NAME_PATTERN} (got ${JSON.stringify(name)})`)
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`skill "${name}": description is required`)
  }
  if (typeof content !== 'string') {
    throw new Error(`skill "${name}": content must be a string`)
  }
  if (files !== undefined && !Array.isArray(files)) {
    throw new Error(`skill "${name}": files must be an array of { path, content }`)
  }
  const seen = new Set<string>()
  const normalizedFiles = (files ?? []).map((f) => {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      throw new Error(`skill "${name}": every file needs a string path and content`)
    }
    let p: string
    try {
      p = normalizeSkillPath(f.path)
    } catch (err) {
      throw new Error(`skill "${name}": ${(err as Error).message}`)
    }
    if (seen.has(p)) {
      throw new Error(`skill "${name}": duplicate file "${p}"`)
    }
    seen.add(p)
    return { path: p, content: f.content }
  })
  return {
    name,
    description: description.trim(),
    content,
    ...(normalizedFiles.length ? { files: normalizedFiles } : {}),
  }
}

const unquote = (raw: string): string => {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'")
  }
  // Plain scalar: strip a trailing " # comment".
  return v.replace(/\s+#.*$/, '')
}

// Minimal YAML subset: top-level `key: value` pairs with plain / quoted
// scalars and `>` / `|` block scalars (with optional -/+ chomping).
// Nested maps and lists are skipped.
const parseFrontmatter = (block: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const lines = block.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line)
    if (!m) {
      continue
    }
    const key = m[1]
    const rest = m[2].trim()
    const block = /^([>|])([+-]?)\s*(#.*)?$/.exec(rest)
    if (block) {
      const collected: string[] = []
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        collected.push(lines[++i])
      }
      while (collected.length && collected[collected.length - 1].trim() === '') {
        collected.pop()
      }
      const indent = Math.min(
        ...collected.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length),
      )
      const body = collected.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
      out[key] =
        block[1] === '|'
          ? body.join('\n')
          : body
              .join('\n')
              .split(/\n\s*\n/)
              .map((para) => para.replace(/\n/g, ' ').trim())
              .join('\n')
      continue
    }
    out[key] = unquote(rest)
  }
  return out
}

/**
 * Parse a SKILL.md: YAML-ish frontmatter between `---` lines with `name:`
 * and `description:`, the body is the content. Throws a clear error when the
 * frontmatter, the name or the description is missing or the name invalid.
 */
export const parseSkillMarkdown = (
  markdown: string,
  files?: { path: string; content: string }[],
): ISkill => {
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const m = /^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!m) {
    throw new Error('SKILL.md must start with a frontmatter block between "---" lines')
  }
  const meta = parseFrontmatter(m[1])
  if (!meta.name) {
    throw new Error('SKILL.md frontmatter is missing "name"')
  }
  if (!meta.description) {
    throw new Error(`SKILL.md "${meta.name}": frontmatter is missing "description"`)
  }
  return defineSkill({
    name: meta.name,
    description: meta.description,
    content: text.slice(m[0].length).trim(),
    ...(files?.length ? { files } : {}),
  })
}

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.ts',
  '.js',
  '.py',
  '.sh',
  '.html',
  '.css',
  '.xml',
  '.toml',
])
const MAX_SKILL_FILE_BYTES = 256 * 1024

const collectFiles = async (
  root: string,
  dir: string,
  out: { path: string; content: string }[],
): Promise<void> => {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') {
      continue
    }
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await collectFiles(root, full, out)
      continue
    }
    if (!e.isFile()) {
      continue
    }
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (rel === 'SKILL.md' || !TEXT_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      continue
    }
    if ((await stat(full)).size > MAX_SKILL_FILE_BYTES) {
      continue
    }
    out.push({ path: rel, content: await readFile(full, 'utf8') })
  }
}

/**
 * Load every `<dir>/<skill>/SKILL.md`. Bundled files are the other text
 * files under that skill folder (recursive; text extensions only; files over
 * 256 KB skipped). Folders without a SKILL.md are ignored; duplicate skill
 * names throw.
 */
export const loadSkillsFromDir = async (dir: string): Promise<ISkill[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const skills: ISkill[] = []
  const names = new Set<string>()
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') {
      continue
    }
    const skillDir = path.join(dir, e.name)
    let markdown: string
    try {
      markdown = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const files: { path: string; content: string }[] = []
    await collectFiles(skillDir, skillDir, files)
    let skill: ISkill
    try {
      skill = parseSkillMarkdown(markdown, files)
    } catch (err) {
      throw new Error(`${path.join(skillDir, 'SKILL.md')}: ${(err as Error).message}`)
    }
    if (names.has(skill.name)) {
      throw new Error(`duplicate skill name "${skill.name}" in ${dir}`)
    }
    names.add(skill.name)
    skills.push(skill)
  }
  return skills
}

// Validate a configured skill list (shapes + unique names).
export const validateSkills = (skills: ISkill[] | undefined): ISkill[] => {
  const out: ISkill[] = []
  const names = new Set<string>()
  for (const s of skills ?? []) {
    const skill = defineSkill(s)
    if (names.has(skill.name)) {
      throw new Error(`duplicate skill name "${skill.name}"`)
    }
    names.add(skill.name)
    out.push(skill)
  }
  return out
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// "- name: description" lines for the planner / executor system prompts.
export const renderSkillsIndex = (skills: ISkill[]): string =>
  skills.map((s) => `- ${s.name}: ${oneLine(s.description, 300)}`).join('\n')

/**
 * The instructions of the active skills, in activation order, within a char
 * budget (the rest is clipped with a marker).
 */
export const renderActiveSkills = (
  skills: ISkill[],
  active: string[],
  budget = ACTIVE_SKILLS_BUDGET_CHARS,
): string => {
  const byName = new Map(skills.map((s) => [s.name, s]))
  const parts: string[] = []
  let used = 0
  for (const name of active) {
    const skill = byName.get(name)
    if (!skill) {
      continue
    }
    const block = `### Skill: ${skill.name}\n${skill.content.trim()}`
    const left = budget - used
    if (left <= 0) {
      parts.push(`### Skill: ${skill.name}\n… [skill instructions clipped: budget exhausted]`)
      continue
    }
    if (block.length > left) {
      parts.push(`${block.slice(0, left)}\n… [skill instructions clipped]`)
      used = budget
      continue
    }
    parts.push(block)
    used += block.length
  }
  return parts.join('\n\n')
}

/**
 * Activate a skill for the rest of the current run (idempotent). Emits
 * skill.activated once per skill and run. Returns false for an unknown name.
 */
export const activateSkill = (
  skills: ISkill[],
  name: string,
  by: 'plan' | 'tool',
  target?: { activeSkills: string[] },
  emit?: (event: { type: 'skill.activated'; name: string; by: 'plan' | 'tool' }) => void,
): boolean => {
  if (!skills.some((s) => s.name === name)) {
    return false
  }
  if (target && !target.activeSkills.includes(name)) {
    target.activeSkills.push(name)
    emit?.({ type: 'skill.activated', name, by })
  }
  return true
}

// The built-in load_skill / read_skill_file tools. Read-only, never need
// approval; they activate skills in the CURRENT run via the run context.
export const createSkillTools = (skills: ISkill[]): ToolSet => {
  if (!skills.length) {
    return {}
  }
  const names = skills.map((s) => s.name)
  const find = (name: string): ISkill => {
    const skill = skills.find((s) => s.name === name)
    if (!skill) {
      throw new Error(`Unknown skill "${name}". Available skills: ${names.join(', ')}`)
    }
    return skill
  }
  return {
    [LOAD_SKILL_TOOL]: markReadOnly(
      tool({
        description:
          'Load the full instructions of a skill from the SKILLS list and activate it for the rest of the task. Call it before doing work a skill covers.',
        inputSchema: z.object({
          name: z.string().describe(`Skill name, one of: ${names.join(', ')}`),
        }),
        execute: async ({ name }) => {
          const skill = find(name)
          const store = runContext.getStore()
          activateSkill(skills, skill.name, 'tool', store?.state, store?.emit)
          return {
            name: skill.name,
            content: skill.content,
            files: (skill.files ?? []).map((f) => f.path),
          }
        },
      }),
    ),
    [READ_SKILL_FILE_TOOL]: markReadOnly(
      tool({
        description:
          'Read a file bundled with a skill (paths are listed by load_skill). Returns the file content.',
        inputSchema: z.object({
          name: z.string().describe('Skill name'),
          path: z.string().describe('Skill-relative file path, as listed by load_skill'),
        }),
        execute: async ({ name, path: filePath }) => {
          const skill = find(name)
          let wanted: string
          try {
            wanted = normalizeSkillPath(filePath)
          } catch (err) {
            throw new Error((err as Error).message)
          }
          const file = (skill.files ?? []).find((f) => f.path === wanted)
          if (!file) {
            const listed = (skill.files ?? []).map((f) => f.path)
            throw new Error(
              `Skill "${skill.name}" has no file "${filePath}". Files: ${listed.length ? listed.join(', ') : '(none)'}`,
            )
          }
          return file.content
        },
      }),
    ),
  }
}
