import assert from 'node:assert/strict'
import test from 'node:test'
import {
  renderSearchCatalog,
  resolveToolStrategy,
  searchTools,
  tokenizeForSearch,
} from '../src/tool-search.ts'

const catalog = [
  { name: 'github__list_issues', description: 'List issues of a repository', server: 'github' },
  { name: 'github__create_issue', description: 'Open a new issue', server: 'github' },
  { name: 'jira__searchIssues', description: 'JQL search over tickets', server: 'jira' },
  { name: 'weather__forecast', description: 'Weather forecast for a city', server: 'weather' },
  {
    name: 'files__read',
    description: 'Read a file from the issue tracker export',
    server: 'files',
  },
]

test('tokenizeForSearch splits on non-alphanumerics and camelCase, lowercased', () => {
  assert.deepEqual(tokenizeForSearch('jira__searchIssues'), ['jira', 'search', 'issues'])
  assert.deepEqual(tokenizeForSearch('getHTTPResponse v2'), ['get', 'http', 'response', 'v2'])
})

test('searchTools scores 3·name + 2·server + 1·description per query term', () => {
  const names = searchTools(catalog, 'issue').map((t) => t.name)
  // name + description (4) beat name only (3) beat a description-only hit
  // (1); ties keep catalogue order.
  assert.deepEqual(names, [
    'github__list_issues',
    'github__create_issue',
    'jira__searchIssues',
    'files__read',
  ])
  // A longer term does not prefix-match a shorter token.
  assert.deepEqual(
    searchTools(catalog, 'issues').map((t) => t.name),
    ['github__list_issues', 'jira__searchIssues'],
  )
})

test('searchTools: prefix matching for 3+ char terms, exact match for shorter ones', () => {
  assert.deepEqual(
    searchTools(catalog, 'forec').map((t) => t.name),
    ['weather__forecast'],
  )
  // "is" is too short to prefix-match "issue(s)".
  assert.deepEqual(searchTools(catalog, 'is'), [])
})

test('searchTools: server filter, zero-score exclusion and limit clamping', () => {
  assert.deepEqual(
    searchTools(catalog, 'issue', { server: 'jira' }).map((t) => t.name),
    ['jira__searchIssues'],
  )
  assert.deepEqual(searchTools(catalog, 'nothing-matches-this'), [])
  assert.equal(searchTools(catalog, 'issue', { limit: 1 }).length, 1)
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `t${i}__thing`,
    description: 'thing',
    server: 's',
  }))
  assert.equal(searchTools(many, 'thing', { limit: 500 }).length, 20)
  assert.equal(searchTools(many, 'thing').length, 8)
})

test('searchTools: a server-name term scores on server too', () => {
  const ranked = searchTools(catalog, 'github issue')
  assert.equal(ranked[0].name, 'github__list_issues')
  assert.equal(ranked[1].name, 'github__create_issue')
})

test("resolveToolStrategy: 'auto' is 'all' up to the threshold, 'search' above", () => {
  assert.equal(resolveToolStrategy({}, 40), 'all')
  assert.equal(resolveToolStrategy({}, 41), 'search')
  assert.equal(resolveToolStrategy({ toolSearchThreshold: 5 }, 6), 'search')
  assert.equal(resolveToolStrategy({ toolSelectionStrategy: 'all' }, 500), 'all')
  assert.equal(resolveToolStrategy({ toolSelectionStrategy: 'plan-narrowed' }, 1), 'plan-narrowed')
})

test('renderSearchCatalog groups by server within a budget and points at find_tools', () => {
  const out = renderSearchCatalog(catalog)
  assert.match(out, /^\[github\]\n- github__list_issues: List issues of a repository/)
  assert.ok(out.includes('[weather]'))
  assert.ok(!out.includes('more tools'))

  const big = Array.from({ length: 500 }, (_, i) => ({
    name: `srv__tool_${i}`,
    description: 'x'.repeat(200),
    server: 'srv',
  }))
  const clipped = renderSearchCatalog(big, 2_000)
  assert.ok(clipped.length < 2_200)
  assert.match(clipped, /… \d+ more tools — the executor can find them with find_tools$/)
  // Descriptions are cut to 60 chars.
  assert.ok(clipped.split('\n')[1].endsWith('x'.repeat(60)))
})
