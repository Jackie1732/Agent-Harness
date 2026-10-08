import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { builtUiFixture, builtUiLostReceiptFixture } from './ui-built-fixture.mjs'

// This gate owns a fresh headless browser and real built Host/API/UI; it never uses user browser state.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL('../.tmp/playwright-browsers/', import.meta.url))
const { chromium } = await import('playwright')
const output = fileURLToPath(new URL('../.tmp/step14-browser/', import.meta.url))
await mkdir(output, { recursive: true })
test('browser preserves the captured input identity through pending, unknown and rejected receipts', { timeout: 60000 }, async () => {
  const fixture = await builtUiLostReceiptFixture(), browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const ready = async () => { await page.waitForFunction(() => document.getElementById('busy-label').textContent === '') }
    await page.goto(fixture.ui.ready.url)
    await page.getByLabel('操作者口令').fill(fixture.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('#workspace').waitFor({ state: 'visible' }); await ready()
    const task = page.locator('#task-form'), key = task.getByLabel('提交键', { exact: true }), text = task.getByLabel('任务', { exact: true })
    await key.fill('known-previous'); await text.fill('Previous task'); await task.getByRole('button').click(); await ready()
    await key.fill('unknown-original'); await text.fill('Actual durable original'); await task.getByRole('button').click(); await fixture.waitAccepted
    const pendingOriginal = (await page.locator('#input-result').innerText()).includes('unknown-original')
    assert.equal(await page.locator('#member-select').isDisabled(), true)
    assert.equal(await page.locator('#workflow-select').isDisabled(), true)
    await key.fill('edited-after-dispatch'); await text.fill('Different task that was never sent')
    fixture.releaseReceipt(); await ready()
    const unknown = await page.locator('#input-result').innerText(), queryKey = await page.locator('#input-form input[name="value"]').inputValue()
    const received = page.waitForResponse(response => response.url().endsWith('/api/control'))
    await page.locator('#input-form').getByRole('button').click()
    const response = await received, queried = await response.json(); await ready()
    await key.fill('rejected key'); await task.getByRole('button').click(); await ready()
    const rejected = await page.locator('#input-result').innerText()
    assert.deepEqual({ pendingOriginal, unknownOriginal: unknown.includes('unknown-original'), unknownStatus: unknown.includes('unknown'),
      queryKey, recoveryKey: response.request().postDataJSON().params.submissionKey, recovered: queried.result.submission.key,
      rejectedOriginal: rejected.includes('rejected key'), rejectedStatus: rejected.includes('not-accepted'), submissions: fixture.submissions },
    { pendingOriginal: true, unknownOriginal: true, unknownStatus: true, queryKey: 'unknown-original', recoveryKey: 'unknown-original',
      recovered: 'unknown-original', rejectedOriginal: true, rejectedStatus: true, submissions: 2 })
    assert.equal(fixture.service.status, 'ready')
  } finally { await browser.close(); await fixture.dispose() }
})

test('browser spawns a real Child, waits for business and closes its original delegation', { timeout: 60000 }, async () => {
  const fixture = await builtUiFixture({ question: true, child: true }), browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const ready = async () => { await page.waitForFunction(() => document.getElementById('busy-label').textContent === '') }
    const controlClick = async (form, name) => {
      const received = page.waitForResponse(response => response.url().endsWith('/api/control'))
      await page.locator(form).getByRole('button', { name, exact: true }).click()
      const response = await received, result = await response.json(); await ready()
      assert.equal(result.kind, 'result', JSON.stringify(result.error))
      return result.result
    }
    await page.goto(fixture.ui.ready.url)
    await page.getByLabel('操作者口令').fill(fixture.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('#workspace').waitFor({ state: 'visible' }); await ready()
    await page.locator('#root-select').selectOption({ index: 1 })
    await controlClick('#root-form', '查询')
    const parentRoot = await page.locator('#root-form input[name="rootId"]').inputValue()
    await page.getByRole('button', { name: 'Child', exact: true }).click()
    const spawn = page.locator('#child-spawn-form')
    assert.equal(await spawn.getByLabel('Parent Root', { exact: true }).inputValue(), parentRoot)
    await spawn.getByLabel('请求键', { exact: true }).fill('browser-child-spawn')
    await spawn.getByLabel('模板键', { exact: true }).fill('research')
    await spawn.getByLabel('Child 任务', { exact: true }).fill('Check the supplied evidence.')
    await spawn.locator('textarea[name="materials"]').fill('[{"label":"evidence","text":"Forty-two is the supplied observation."}]')
    for (const [name, value] of Object.entries({ models: 4, steps: 4, tools: 0, messages: 4, waits: 2, outputTokens: 1024 })) await spawn.locator(`input[name="${name}"]`).fill(String(value))
    const receipt = await controlClick('#child-spawn-form', '接纳委派')
    assert.equal(await controlClick('#child-spawn-form', '接纳委派').then(result => result.delegationId), receipt.delegationId)
    assert.equal(await page.locator('#child-form input[name="delegationId"]').inputValue(), receipt.delegationId)
    await page.locator('#run').click(); await ready()
    assert.equal((await controlClick('#child-form', '查询')).resultAvailable, true)
    const business = await controlClick('#child-form', '有限等待')
    assert.equal(business.status, 'condition-met'); assert.equal(business.observation.businessResolved, true)
    assert.match(await page.locator('#child-result').innerText(), /等待结果：condition-met/)
    await page.getByRole('button', { name: '任务 / Root', exact: true }).click()
    await controlClick('#root-form', '查询')
    const answer = page.locator('#root-result form')
    await answer.getByLabel('回答提交键').fill('browser-child-parent-answer')
    await answer.getByLabel('回答', { exact: true }).fill('Confirmed')
    await controlClick('#root-result form', '接纳这个精确等待的回答')
    await page.locator('#run').click(); await ready()
    await page.getByRole('button', { name: 'Child', exact: true }).click()
    await page.locator('#child-form select[name="until"]').selectOption('closed')
    const closed = await controlClick('#child-form', '有限等待')
    assert.equal(closed.status, 'condition-met'); assert.equal(closed.observation.closed, true)
    assert.match(await page.locator('#child-result').innerText(), /资源与协议关闭：是/)
    await page.getByRole('button', { name: '事件历史', exact: true }).click()
    await page.locator('#events-form select[name="kind"]').selectOption('child')
    await page.locator('#events-form input[name="maxEvents"]').fill('100')
    const events = await controlClick('#events-form', '捕获前缀并读取')
    assert.equal(events.sessionId, receipt.childSessionId)
    assert.ok(events.events.some(event => event.type === 'subagent/child-bound'))
    assert.equal(fixture.service.status, 'ready')
  } finally { await browser.close(); await fixture.dispose() }
})

test('browser retains wait outcomes, the last successful event cut and current member identities', { timeout: 60000 }, async () => {
  const fixture = await builtUiFixture({ question: true, workflow: true })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const ready = async () => { await page.waitForFunction(() => document.getElementById('busy-label').textContent === '') }
    const controlClick = async (form, name) => {
      const received = page.waitForResponse(response => response.url().endsWith('/api/control'))
      await page.locator(form).getByRole('button', { name, exact: true }).click()
      const response = await received, result = await response.json(); await ready()
      return { request: response.request().postDataJSON(), result }
    }
    await page.goto(fixture.ui.ready.url)
    await page.getByLabel('操作者口令').fill(fixture.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('#workspace').waitFor({ state: 'visible' }); await ready()
    await page.locator('#root-select').selectOption({ index: 1 })
    await page.locator('#root-form input[name="timeoutMs"]').fill('1')
    const rootWait = await controlClick('#root-form', '有限等待终态')
    assert.equal(rootWait.result.result.status, 'timeout')
    const rootWaitVisible = (await page.locator('#root-result').innerText()).includes('等待结果：timeout')
    await page.getByRole('button', { name: 'Workflow', exact: true }).click()
    await page.locator('#workflow-form input[name="timeoutMs"]').fill('1')
    const workflowWait = await controlClick('#workflow-form', '有限等待')
    assert.equal(workflowWait.result.result.status, 'timeout')
    const workflowWaitVisible = (await page.locator('#workflow-result').innerText()).includes('等待结果：timeout')
    await page.getByRole('button', { name: '事件历史', exact: true }).click()
    await page.locator('#events-form input[name="maxEvents"]').fill('2')
    const first = await controlClick('#events-form', '捕获前缀并读取')
    assert.equal(first.result.result.hasMore, true)
    await page.locator('#events-form select[name="kind"]').selectOption('child')
    assert.equal((await controlClick('#events-form', '捕获前缀并读取')).result.kind, 'error')
    const received = page.waitForResponse(response => response.url().endsWith('/api/control'))
    await page.locator('#events-next').click()
    const response = await received, next = await response.json(); await ready()
    const nextQuery = response.request().postDataJSON().params
    await page.getByRole('button', { name: '任务 / Root', exact: true }).click()
    await page.locator('#task-form input[name="submissionKey"]').fill('browser-member-input')
    await page.locator('#task-form textarea[name="text"]').fill('Writer task')
    await controlClick('#task-form', '接纳任务')
    await page.getByRole('button', { name: 'Session 通信', exact: true }).click()
    await page.locator('#message-form input[name="peerKey"]').fill('reviewer')
    await controlClick('#message-form', '接纳消息')
    assert.notEqual(await page.locator('#message-query-form input[name="messageId"]').inputValue(), '')
    await page.locator('#member-select').selectOption('reviewer'); await ready()
    assert.deepEqual({ rootWaitVisible, workflowWaitVisible, nextTarget: nextQuery.target,
      nextCursor: nextQuery.cursor, nextKind: next.kind, input: await page.locator('#input-result').innerText(),
      inputKey: await page.locator('#input-form input[name="value"]').inputValue(), message: await page.locator('#message-result').innerText(),
      messageId: await page.locator('#message-query-form input[name="messageId"]').inputValue() },
    { rootWaitVisible: true, workflowWaitVisible: true, nextTarget: first.request.params.target,
      nextCursor: first.result.result.nextCursor, nextKind: 'result', input: '', inputKey: '', message: '', messageId: '' })
  } finally { await browser.close(); await fixture.dispose() }
})

test('Chromium operates exact human answers, tasks, messages, fixed events and accepted workflow output', { timeout: 120000 }, async () => {
  const fixture = await builtUiFixture({ question: true, workflow: true })
  let browser, context, page
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.ATOMIC_HARNESS_BROWSER_CHANNEL === undefined ? {} : { channel: process.env.ATOMIC_HARNESS_BROWSER_CHANNEL }) })
    context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    page = await context.newPage(); const errors = []
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
    const ready = async () => { await page.waitForFunction(() => document.getElementById('busy-label').textContent === '') }
    const queryRoot = async () => { await page.locator('#root-form').getByRole('button', { name: '查询', exact: true }).click(); await ready() }
    await page.goto(fixture.ui.ready.url)
    await page.getByLabel('操作者口令').fill(fixture.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('#workspace').waitFor({ state: 'visible' }); await ready()
    await page.locator('#root-select').selectOption({ index: 1 }); await queryRoot()
    assert.match(await page.locator('#root-result').innerText(), /请确认研究结果应使用 Markdown 格式/)
    const answer = page.locator('#root-result form')
    await answer.getByLabel('回答提交键').fill('browser-exact-answer')
    await answer.getByLabel('回答', { exact: true }).fill('Markdown')
    await answer.getByRole('button').click(); await ready()
    assert.match(await page.locator('#operation-result').innerText(), /input.answer/)
    await page.locator('#run').click(); await ready(); await queryRoot()
    assert.match(await page.locator('#root-result').innerText(), /completed/)
    const task = page.locator('#task-form')
    await task.getByLabel('提交键', { exact: true }).fill('browser-task')
    await task.getByLabel('任务', { exact: true }).fill('<script id="injected">throw new Error("injected")</script> research task')
    await task.getByRole('button').click(); await ready()
    await task.getByRole('button').click(); await ready()
    assert.match(await page.locator('#input-result').innerText(), /复用/)
    await page.locator('#run').click(); await ready()
    await page.locator('#input-form').getByRole('button').click(); await ready(); await queryRoot()
    assert.match(await page.locator('#root-result').innerText(), /completed/)
    const rootField = page.locator('#root-form input[name="rootId"]'), currentRoot = await rootField.inputValue()
    assert.equal(await page.locator('#root-select').inputValue(), currentRoot)
    await rootField.fill('ah-event:70000000-0000-4000-8000-000000000101:999999')
    assert.equal(await page.locator('#root-select').inputValue(), '')
    await rootField.fill(currentRoot)
    await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await ready()
    assert.equal(await page.locator('#root-select').inputValue(), currentRoot)
    await queryRoot()
    assert.equal(await page.locator('#injected').count(), 0)
    await page.screenshot({ path: `${output}/tasks.png`, fullPage: true })
    await page.getByRole('button', { name: 'Session 通信', exact: true }).click()
    const message = page.locator('#message-form')
    await message.getByLabel('Peer 键（发送）').fill('reviewer')
    await message.getByLabel('JSON 载荷').fill('{"text":"browser research evidence"}')
    await message.getByRole('button').click(); await ready()
    await page.locator('#message-result summary').click()
    assert.match(await page.locator('#message-result').innerText(), /outbox-accepted/)
    await page.locator('#run').click(); await ready()
    await page.locator('#message-query-form').getByRole('button', { name: '查询', exact: true }).click(); await ready()
    await page.locator('#message-result summary').click()
    assert.match(await page.locator('#message-result').innerText(), /messageId/)
    await page.getByRole('button', { name: '事件历史', exact: true }).click()
    await page.locator('#events-form input[name="maxEvents"]').fill('2')
    await page.locator('#events-form').getByRole('button').click(); await ready()
    const first = await page.locator('#events-result').innerText(), through = first.match(/through=(\d+)/)[1]
    await page.locator('#events-next').click(); await ready()
    assert.match(await page.locator('#events-result').innerText(), new RegExp(`through=${through} ·`))
    await page.screenshot({ path: `${output}/events.png`, fullPage: true })
    await page.getByRole('button', { name: 'Workflow', exact: true }).click()
    const workflow = page.locator('#workflow-form')
    await workflow.getByLabel('控制请求键').fill('browser-workflow-resume')
    await workflow.getByRole('button', { name: '恢复 Workflow', exact: true }).click(); await ready()
    await page.locator('#run').click(); await ready()
    await workflow.getByRole('button', { name: '查询', exact: true }).click(); await ready()
    assert.match(await page.locator('#workflow-result').innerText(), /资源与协议关闭：是/, await page.locator('#notice').textContent())
    await page.locator('#workflow-result').getByRole('button', { name: /^读取产物 / }).first().click(); await ready()
    assert.match(await page.locator('#artifact-result').innerText(), /writer answer/)
    await page.screenshot({ path: `${output}/workflow.png`, fullPage: true })
    assert.deepEqual(errors, [])
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await page.locator('#login-view').waitFor({ state: 'visible' })
    assert.equal(fixture.service.status, 'ready')
  } finally {
    if (page !== undefined) await page.screenshot({ path: `${output}/last.png`, fullPage: true })
    if (context !== undefined) await context.tracing.stop({ path: `${output}/trace.zip` })
    await browser?.close(); await fixture.dispose()
  }
})
