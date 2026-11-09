import { tool, type ToolSet } from 'ai'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { runContext } from './context.ts'
import { SKILL_NAME_PATTERN, defineSkill, loadSkillsFromDir } from './skills.ts'
import type { EventHandler, ILearningConfig, ISkill, ISkillStore } from './types.ts'

// The agent keeps a notebook that outlives a task.
//
// When it hits a problem and finds the way around it - a tool error it resolved, a wrong
// assumption it corrected, a procedure it had to look up - it writes the lesson down as a SKILL
// (the same agentskills.io shape as the operator's own), and from then on that skill is in the
// SKILLS index of the planner and the executor, loadable with load_skill, for the rest of the
// open session (and across sessions if the store persists).
//
// What it may change is knowledge, never policy. A lesson is text the model reads later: it
// cannot alter the approval mode, the egress policy, the tool set or any limit, and every tool it
// is advised to call still goes through the same gates. And because a lesson may have been
// written after reading a web page, it is treated as what it is - a hint from experience, not an
// instruction from the user:
//
//  - saving goes through the approval gate like any write (ask-writes asks the human);
//  - nothing that looks like a credential is stored; size and count are capped;
//  - an operator's skill is never overwritten; only the agent's own can be updated or forgotten;
//  - each lesson records where it came from: the run, the sources the model named, and - not
//    chosen by the model - every page web_fetch read during that run;
//  - when loaded, a lesson is introduced as a note of the agent's own, subordinate to the user.

export const SAVE_SKILL_TOOL = 'save_skill'
export const FORGET_SKILL_TOOL = 'forget_skill'
export const DEFAULT_MAX_LEARNED_SKILLS = 50
export const DEFAULT_MAX_SKILL_CHARS = 6_000
const MAX_DESCRIPTION_CHARS = 300
const MIN_INSTRUCTIONS_CHARS = 20

// Credentials are the one thing a notebook must never keep: it is read back into prompts, shown
// in UIs and (with a persistent store) written to disk.
const SECRET_PATTERNS: [string, RegExp][] = [
  ['an API key (sk-...)', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'a password or secret assignment',
    /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
  ],
]

// What a credential looks like, or undefined.
export const findSecret = (text: string): string | undefined =>
  SECRET_PATTERNS.find(([, re]) => re.test(text))?.[0]

// "My Trick_1" -> "my-trick-1"; undefined when nothing usable is left.
export const normalizeSkillName = (raw: string): string | undefined => {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/, '')
  return SKILL_NAME_PATTERN.test(name) ? name : undefined
}

// A URL kept as origin + path: a query string can carry a secret.
const plainUrl = (raw: string): string => {
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname}`
  } catch {
    return raw.slice(0, 120)
  }
}

// ── stores ───────────────────────────────────────────────────────────────────

// Lives as long as the agent: the "open session".
export class MemorySkillStore implements ISkillStore {
  private readonly skills = new Map<string, ISkill>()

  list(): ISkill[] {
    return [...this.skills.values()]
  }

  save(skill: ISkill): void {
    this.skills.set(skill.name, skill)
  }

  remove(name: string): boolean {
    return this.skills.delete(name)
  }
}

const ORIGIN_FILE = '.origin.json'

// <dir>/<name>/SKILL.md (the operator can read, edit, delete or commit them like their own
// skills) plus a dotfile with where each came from. Written atomically.
export class DirSkillStore implements ISkillStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async list(): Promise<ISkill[]> {
    let skills: ISkill[]
    try {
      skills = await loadSkillsFromDir(this.dir)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return []
      }
      throw err
    }
    return Promise.all(
      skills.map(async (s) => {
        try {
          const origin = JSON.parse(
            await readFile(path.join(this.dir, s.name, ORIGIN_FILE), 'utf8'),
          )
          return { ...s, origin }
        } catch {
          // Someone dropped a skill in by hand: it is theirs, not learned.
          return s
        }
      }),
    )
  }

  async save(skill: ISkill): Promise<void> {
    if (!SKILL_NAME_PATTERN.test(skill.name)) {
      throw new Error(`invalid skill name "${skill.name}"`)
    }
    const folder = path.join(this.dir, skill.name)
    await mkdir(folder, { recursive: true })
    const markdown = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content.trim()}\n`
    const tmp = path.join(folder, `.SKILL.md.${process.pid}.tmp`)
    await writeFile(tmp, markdown, 'utf8')
    await rename(tmp, path.join(folder, 'SKILL.md'))
    if (skill.origin) {
      await writeFile(path.join(folder, ORIGIN_FILE), JSON.stringify(skill.origin, null, 2), 'utf8')
    }
  }

  async remove(name: string): Promise<boolean> {
    if (!SKILL_NAME_PATTERN.test(name)) {
      return false
    }
    const folder = path.join(this.dir, name)
    const present = (await readdir(this.dir).catch(() => [] as string[])).includes(name)
    if (present) {
      await rm(folder, { recursive: true, force: true })
    }
    return present
  }
}

// ── learning ─────────────────────────────────────────────────────────────────

export interface ILearning {
  // The tools the model learns with (normal tools: gated, counted).
  tools: ToolSet
  // The agent's own skills (not the operator's).
  learned: () => ISkill[]
  // Forget one of them. false when there is no such learned skill.
  forget: (name: string) => Promise<boolean>
}

export interface ISaveSkillInput {
  name: string
  description: string
  instructions: string
  sources?: string[]
}

// Wires learning to the agent's LIVE skill list (`skills` is mutated in place, so every prompt
// that renders the index sees a new lesson at once).
export const createLearning = async (
  cfg: ILearningConfig,
  skills: ISkill[],
  emit: EventHandler,
  warn: (message: string) => void,
): Promise<ILearning> => {
  const store = cfg.store ?? new MemorySkillStore()
  const maxSkills = Math.max(1, cfg.maxSkills ?? DEFAULT_MAX_LEARNED_SKILLS)
  const maxChars = Math.max(MIN_INSTRUCTIONS_CHARS, cfg.maxSkillChars ?? DEFAULT_MAX_SKILL_CHARS)

  // What an earlier session wrote. The operator's own skills win a name clash.
  for (const stored of await store.list()) {
    try {
      const skill = defineSkill({
        ...stored,
        origin: stored.origin ?? { kind: 'learned', at: 0, revision: 1 },
      })
      if (skills.some((s) => s.name === skill.name)) {
        warn(
          `[learning] a stored lesson named "${skill.name}" clashes with a configured skill; skipped`,
        )
        continue
      }
      skills.push(skill)
    } catch (err) {
      warn(`[learning] a stored lesson was skipped: ${(err as Error).message}`)
    }
  }

  const learned = (): ISkill[] => skills.filter((s) => s.origin?.kind === 'learned')

  const save = async (
    input: ISaveSkillInput,
  ): Promise<{ saved: true; name: string; update: boolean }> => {
    const name = normalizeSkillName(input.name)
    if (!name) {
      throw new Error(
        `"${input.name}" is not a usable skill name - use a few lower-case words with dashes, like "retry-on-429"`,
      )
    }
    const description = input.description.replace(/\s+/g, ' ').trim()
    if (!description) {
      throw new Error(
        'say in `description` WHEN this lesson applies - it is what you will search by later',
      )
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      throw new Error(`keep \`description\` under ${MAX_DESCRIPTION_CHARS} characters`)
    }
    const content = input.instructions.trim()
    if (content.length < MIN_INSTRUCTIONS_CHARS) {
      throw new Error('write the steps that worked in `instructions` - a line is not a lesson')
    }
    if (content.length > maxChars) {
      throw new Error(
        `\`instructions\` is ${content.length} characters; keep it under ${maxChars} - distil it`,
      )
    }
    const sources = (input.sources ?? []).slice(0, 5).map((s) => plainUrl(s))
    // Scanned as given, before the query strings are cut off: a key in one is worth refusing.
    const secret = findSecret([name, description, content, ...(input.sources ?? [])].join('\n'))
    if (secret) {
      throw new Error(
        `refused: this looks like it contains ${secret}. Save the procedure, never the secret - describe where to find it instead`,
      )
    }
    const existing = skills.find((s) => s.name === name)
    if (existing && existing.origin?.kind !== 'learned') {
      throw new Error(
        `"${name}" is a skill the operator configured and cannot be changed - pick another name`,
      )
    }
    if (!existing && learned().length >= maxSkills) {
      throw new Error(
        `the notebook is full (${maxSkills} lessons) - update one of your own or forget_skill an outdated one first`,
      )
    }
    const run = runContext.getStore()
    const fetched = [...new Set(run?.state?.fetched ?? [])].slice(0, 10)
    const skill = defineSkill({
      name,
      description,
      content,
      origin: {
        kind: 'learned',
        at: Date.now(),
        revision: (existing?.origin?.revision ?? 0) + 1,
        ...(run?.runId ? { runId: run.runId } : {}),
        ...(sources.length ? { sources } : {}),
        ...(fetched.length ? { fetched } : {}),
      },
    })
    await store.save(skill)
    const at = skills.findIndex((s) => s.name === name)
    if (at >= 0) {
      skills[at] = skill
    } else {
      skills.push(skill)
    }
    ;(run?.emit ?? emit)({
      type: 'skill.learned',
      name,
      description,
      update: Boolean(existing),
      chars: content.length,
      sources: [...sources, ...fetched],
    })
    return { saved: true, name, update: Boolean(existing) }
  }

  const forget = async (rawName: string): Promise<boolean> => {
    const at = skills.findIndex((s) => s.name === rawName && s.origin?.kind === 'learned')
    if (at < 0) {
      return false
    }
    await store.remove(rawName)
    skills.splice(at, 1)
    ;(runContext.getStore()?.emit ?? emit)({ type: 'skill.forgotten', name: rawName })
    return true
  }

  const tools: ToolSet = {
    [SAVE_SKILL_TOOL]: tool({
      description:
        'Write down a lesson so you can reuse it later in this session: what you did when you got stuck and what worked. ' +
        'Call it once you have SOLVED a problem that was not obvious - a tool error you worked around, an assumption you had wrong, a procedure you had to look up. ' +
        'It becomes a skill in the SKILLS list; load_skill reads it back. Never put secrets, keys or personal data in it. ' +
        'Saving the same name again updates your earlier lesson.',
      inputSchema: z.object({
        name: z.string().describe('A few lower-case words with dashes, e.g. "retry-on-429"'),
        description: z
          .string()
          .describe(
            `WHEN to use this lesson, in one sentence (under ${MAX_DESCRIPTION_CHARS} characters)`,
          ),
        instructions: z
          .string()
          .describe(
            'The steps that worked, as short markdown. What to do, in order, and what to avoid.',
          ),
        sources: z
          .array(z.string())
          .max(5)
          .optional()
          .describe('Where the solution came from (URLs, doc names), if you looked it up'),
      }),
      execute: async (input) => save(input),
    }),
    [FORGET_SKILL_TOOL]: tool({
      description:
        'Delete a lesson YOU wrote earlier that turned out wrong or outdated. Skills the operator configured cannot be deleted.',
      inputSchema: z.object({ name: z.string().describe('The name of your own skill') }),
      execute: async ({ name }) => {
        if (!(await forget(name))) {
          throw new Error(
            `there is no lesson of yours named "${name}" (yours: ${
              learned()
                .map((s) => s.name)
                .join(', ') || 'none'
            })`,
          )
        }
        return { forgotten: true, name }
      },
    }),
  }

  return { tools, learned, forget }
}
