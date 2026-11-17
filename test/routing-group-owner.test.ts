import { afterEach, expect, test } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { mapCatalog, routeOf } from '../src/host/catalog.js'
import { MagpieRuntime } from '../src/host/runtime.js'
import { MagpieAdapter } from '../src/host/adapter.js'
import { buildModelCatalog } from './support/model-catalog.js'
import { collect, mountRealHost, until } from './support/host.js'
import { createGateway, json, sse } from './support/gateway.js'
import { LINE_ID, line, lineCredentials, memoryStore } from './support/line.js'
import { chatText } from './support/wire.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

/** The routing-group shape the gateway actually serves: the group entry keeps the owner's display_name. */
const GATEWAY = { data: [
  { id: 'auto/deepseek-v4.1-flash', owned_by: 'opencode-go', display_name: 'DeepSeek V4.1 Flash', magpie_label: 'DeepSeek V4.1 Flash · routing group' },
  { id: 'opencode-go/deepseek-v4.1-flash', owned_by: 'opencode-go', display_name: 'DeepSeek V4.1 Flash', magpie_label: 'DeepSeek V4.1 Flash · OpenCode Go' },
  { id: 'auto/gpt-6-astra', owned_by: 'f-ai-hub', display_name: 'GPT-6 Astra', magpie_label: 'GPT-6 Astra · routing group' },
  { id: 'f-ai-hub/gpt-6-astra', owned_by: 'f-ai-hub', display_name: 'GPT-6 Astra', magpie_label: 'GPT-6 Astra · F-AI Hub' },
  { id: 'group/my-pick', owned_by: 'opencode-go', display_name: 'My Pick', magpie_label: 'My Pick · routing group' },
] }

test('test_routing_groups_01 spec Scenario "路由组条目使用独立 owner，可见性键保持不变"', () => {
  const mapped = mapCatalog(GATEWAY)
  // auto/* and group/* are routing groups; the label is the only other signal (e.g. a gateway that renames ids).
  expect(mapped.map(m => m.owner)).toEqual(['routing', 'opencode-go', 'routing', 'f-ai-hub', 'routing'])
  // Visibility keys stay the raw owned_by, so saved visibility choices keep their meaning.
  expect(mapped.map(m => m.provider)).toEqual(['opencode-go', 'opencode-go', 'f-ai-hub', 'f-ai-hub', 'opencode-go'])
  expect(mapCatalog({ data: [{ id: 'custom/renamed', owned_by: 'acme', magpie_label: 'Custom · routing group' }] })[0]?.owner).toBe('routing')
  // A lookalike that is not a routing group is still grouped by its owner.
  expect(mapCatalog({ data: [{ id: 'acme/model', owned_by: 'acme', display_name: 'Routing Group Model' }] })[0]?.owner).toBe('acme')
})

test('test_routing_groups_02 spec Scenario "选择器里不再出现同名重复条目"', async () => {
  const gateway = await createGateway()
  gateway.handlers.set('GET /v1/models', json(GATEWAY))
  const host = await mountRealHost({ credentials: lineCredentials('mk-routing'), settings: { lines: [{ id: LINE_ID, baseUrl: gateway.baseUrl, accessMode: 'direct' }] } })
  cleanup.push(gateway.close, () => host.dispose())
  await until(() => host.ownRoutes().length >= 3, 'routes registered')
  expect(host.ownRoutes().sort()).toEqual([routeOf('f-ai-hub'), routeOf('opencode-go'), routeOf('routing')])
  const catalog = await buildModelCatalog(host.llm)
  const groups = Object.fromEntries(catalog.groups.map(g => [g.name, g.models.map(m => m.id)]))
  expect(groups).toEqual({
    'Magpie (Routing)': ['auto/deepseek-v4.1-flash', 'auto/gpt-6-astra', 'group/my-pick'],
    'Magpie (Opencode-go)': ['opencode-go/deepseek-v4.1-flash'],
    'Magpie (F-ai-hub)': ['f-ai-hub/gpt-6-astra'],
  })
  // Within one group every row is now distinct; the duplicate names live in different sections.
  for (const group of catalog.groups) expect(new Set(group.models.map(m => m.name)).size).toBe(group.models.length)
})

test('test_routing_groups_03 spec Scenario "路由组的请求仍按网关 id 透传"', async () => {
  const gateway = await createGateway()
  gateway.handlers.set('GET /v1/models', json(GATEWAY))
  const runtime = new MagpieRuntime(lineCredentials('mk-routing').service, memoryStore([line(gateway.baseUrl)]))
  try {
    await runtime.start()
    gateway.handlers.set('POST /v1/chat/completions', sse(chatText('hi')))
    const options: GenerateOptions = { provider: routeOf('routing'), model: 'auto/deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'U' }] }] }
    const chunks = await collect(new MagpieAdapter(runtime).stream(options))
    expect(chunks.findLast(c => c.type === 'finish')).toMatchObject({ reason: { kind: 'stop' } })
    expect((gateway.requests.find(r => r.method === 'POST')?.body as { model?: string }).model).toBe('auto/deepseek-v4.1-flash')
  } finally { await runtime.dispose(); await gateway.close() }
})
