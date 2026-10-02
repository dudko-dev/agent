import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createSkillTools,
  defineSkill,
  loadSkillsFromDir,
  parseSkillMarkdown,
  renderActiveSkills,
  renderSkillsIndex,
} from '../src/skills.ts'
import { runContext } from '../src/context.ts'
import type { IRunState } from '../src/internal.ts'
import type { AgentEvent } from '../src/types.ts'

test('parseSkillMarkdown: plain frontmatter + body', () => {
  const s = parseSkillMarkdown(
    '---\nname: pdf-tools\ndescription: Work with PDF files\nlicense: MIT\n---\n# PDF\n\nUse pdftotext.\n',
  )
  assert.deepEqual(s, {
    name: 'pdf-tools',
    description: 'Work with PDF files',
    content: '# PDF\n\nUse pdftotext.',
  })
})

test('parseSkillMarkdown: quoted values, CRLF, BOM and a trailing comment', () => {
  const s = parseSkillMarkdown(
    "\uFEFF---\r\nname: \"quoted-name\"\r\ndescription: 'It''s single-quoted'\r\nversion: 1 # ignored\r\n---\r\nBody",
  )
  assert.equal(s.name, 'quoted-name')
  assert.equal(s.description, "It's single-quoted")
  assert.equal(s.content, 'Body')
  const dq = parseSkillMarkdown('---\nname: dq\ndescription: "Say \\"hi\\" twice"\n---\nx')
  assert.equal(dq.description, 'Say "hi" twice')
})

test('parseSkillMarkdown: folded (>) and literal (|) block scalars', () => {
  const folded = parseSkillMarkdown(
    '---\nname: folded\ndescription: >\n  Use when the user\n  asks about invoices.\nmetadata:\n  owner: me\n---\nBody',
  )
  assert.equal(folded.description, 'Use when the user asks about invoices.')
  const literal = parseSkillMarkdown(
    '---\nname: literal\ndescription: |-\n  line one\n  line two\n---\nBody',
  )
  assert.equal(literal.description, 'line one\nline two')
})

test('parseSkillMarkdown: clear errors for a missing frontmatter, name, description or bad name', () => {
  assert.throws(() => parseSkillMarkdown('# no frontmatter'), /frontmatter/)
  assert.throws(() => parseSkillMarkdown('---\ndescription: d\n---\nx'), /missing "name"/)
  assert.throws(() => parseSkillMarkdown('---\nname: ok\n---\nx'), /missing "description"/)
  assert.throws(
    () => parseSkillMarkdown('---\nname: Bad_Name\ndescription: d\n---\nx'),
    /skill name must match/,
  )
})

test('defineSkill validates and normalises bundled file paths', () => {
  const s = defineSkill({
    name: 'x',
    description: '  d  ',
    content: 'c',
    files: [{ path: './ref/a.md', content: 'A' }],
  })
  assert.equal(s.description, 'd')
  assert.deepEqual(s.files, [{ path: 'ref/a.md', content: 'A' }])
  assert.throws(
    () =>
      defineSkill({
        name: 'x',
        description: 'd',
        content: 'c',
        files: [{ path: '../up', content: '' }],
      }),
    /inside the skill/,
  )
  assert.throws(() => defineSkill({ name: 'x', description: '', content: 'c' }), /description/)
})

test('loadSkillsFromDir: SKILL.md per folder, text files bundled, big/binary skipped', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-'))
  try {
    await mkdir(path.join(dir, 'b-skill', 'ref'), { recursive: true })
    await mkdir(path.join(dir, 'a-skill'))
    await mkdir(path.join(dir, 'no-skill'))
    await writeFile(
      path.join(dir, 'b-skill', 'SKILL.md'),
      '---\nname: b-skill\ndescription: B things\n---\nDo B.',
    )
    await writeFile(path.join(dir, 'b-skill', 'ref', 'notes.md'), 'notes')
    await writeFile(path.join(dir, 'b-skill', 'script.py'), 'print(1)')
    await writeFile(path.join(dir, 'b-skill', 'image.png'), Buffer.from([1, 2, 3]))
    await writeFile(path.join(dir, 'b-skill', 'huge.txt'), 'x'.repeat(257 * 1024))
    await writeFile(
      path.join(dir, 'a-skill', 'SKILL.md'),
      '---\nname: a-skill\ndescription: A things\n---\nDo A.',
    )
    await writeFile(path.join(dir, 'no-skill', 'README.md'), 'ignored')

    const skills = await loadSkillsFromDir(dir)
    assert.deepEqual(
      skills.map((s) => s.name),
      ['a-skill', 'b-skill'],
    )
    assert.deepEqual(skills[1].files, [
      { path: 'ref/notes.md', content: 'notes' },
      { path: 'script.py', content: 'print(1)' },
    ])
    assert.equal(skills[0].files, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renderSkillsIndex / renderActiveSkills (budget + clip marker)', () => {
  const skills = [
    defineSkill({ name: 'a', description: 'Alpha\nskill', content: 'A'.repeat(50) }),
    defineSkill({ name: 'b', description: 'Beta', content: 'B'.repeat(50) }),
  ]
  assert.equal(renderSkillsIndex(skills), '- a: Alpha skill\n- b: Beta')
  const full = renderActiveSkills(skills, ['b', 'a'])
  assert.ok(full.indexOf('### Skill: b') < full.indexOf('### Skill: a'))
  const clipped = renderActiveSkills(skills, ['a', 'b'], 80)
  assert.match(clipped, /\[skill instructions clipped/)
})

test('load_skill activates the skill in the run and lists its files; read_skill_file reads them', async () => {
  const skills = [
    defineSkill({
      name: 'invoices',
      description: 'Invoice rules',
      content: 'Always add VAT.',
      files: [{ path: 'rates.json', content: '{"vat":0.2}' }],
    }),
  ]
  const tools = createSkillTools(skills) as Record<
    string,
    { execute: (input: unknown, opts: unknown) => Promise<unknown>; readOnly?: boolean }
  >
  assert.equal(tools.load_skill.readOnly, true)
  const events: AgentEvent[] = []
  const state: IRunState = {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolCalls: 0,
    strategy: 'all',
    discovered: [],
    activeSkills: [],
    traceSummaryUpTo: 0,
  }
  await runContext.run(
    { runId: 'r', startedAt: 0, sandboxDir: '/tmp/x', state, emit: (e) => events.push(e) },
    async () => {
      const loaded = await tools.load_skill.execute({ name: 'invoices' }, {})
      assert.deepEqual(loaded, {
        name: 'invoices',
        content: 'Always add VAT.',
        files: ['rates.json'],
      })
      // Idempotent: a second load does not re-emit.
      await tools.load_skill.execute({ name: 'invoices' }, {})
      assert.equal(
        await tools.read_skill_file.execute({ name: 'invoices', path: './rates.json' }, {}),
        '{"vat":0.2}',
      )
      await assert.rejects(
        () => tools.load_skill.execute({ name: 'nope' }, {}),
        /Available skills: invoices/,
      )
      await assert.rejects(
        () => tools.read_skill_file.execute({ name: 'invoices', path: 'missing.md' }, {}),
        /Files: rates.json/,
      )
    },
  )
  assert.deepEqual(state.activeSkills, ['invoices'])
  assert.deepEqual(
    events.map((e) => e.type === 'skill.activated' && `${e.name}:${e.by}`),
    ['invoices:tool'],
  )
  assert.deepEqual(createSkillTools([]), {})
})
