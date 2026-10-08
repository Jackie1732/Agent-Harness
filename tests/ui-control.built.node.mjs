import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { builtUiFixture } from './ui-built-fixture.mjs'
import { formRequest } from '../src/web/forms.mjs'
import { decodeParams } from '@atomic-harness/core/protocol'

test('operator fields supply complete exact input, material, child and artifact parameters', () => {
  const eventId='ah-event:70000000-0000-4000-8000-000000000101:1', address='ah-session:70000000-0000-4000-8000-000000000101'
  const context={agentKey:'writer',workflowKey:'research',rootId:eventId,parentRoot:eventId,delegationId:eventId,instanceId:'70000000-0000-4000-8000-000000000101'}
  const samples=[['input-form',{lookup:'event',value:eventId},'get'],['child-spawn-form',{parentRoot:eventId,requestKey:'spawn',templateKey:'child',templateVersion:'1',task:'Review',materials:'[{"label":"passage","text":"Evidence"}]',models:'1',steps:'2',tools:'0',messages:'0',waits:'0',outputTokens:'256',workspaceKind:'none'},'get'],
    ['artifact-form',{address,eventId},'get'],['output-form',{nodeKey:'writer'},'get'],['events-form',{kind:'child',maxEvents:'2',after:'0'},'get'],['shutdown-form',{mode:'drain'},'get']]
  for(const[id,fields,operation]of samples){const[method,params]=formRequest(id,fields,operation,context);decodeParams(method,params,{maxBytes:1048576,maxDepth:64,maxNodes:100000})}
  assert.equal(formRequest('input-form',{lookup:'event',value:eventId},'get',context)[1].inputEventId,eventId)
  assert.deepEqual(formRequest('child-spawn-form',samples[1][1],'get',context)[1].request.materials,[{label:'passage',text:'Evidence'}])
})

test('packaged UI assets and CLI preserve explicit task, human wait, event and accepted artifact control', { timeout: 60000 }, async () => {
  assert.match(execFileSync(process.execPath,['dist/host/bin.js','ui','--help'],{encoding:'utf8'}),/atomic-harness ui --config/)
  const fixture = await builtUiFixture({question:true,workflow:true})
  try {
    const asset = await fetch(`${fixture.ui.ready.url}/app.mjs`); assert.match(asset.headers.get('content-type'),/text\/javascript/); assert.match(await asset.text(),/formRequest/)
    const post = async (path,body,cookie) => await fetch(`${fixture.ui.ready.url}${path}`,{method:'POST',headers:{origin:fixture.ui.ready.url,'content-type':'application/json',...(cookie===undefined?{}:{cookie})},body:JSON.stringify(body)})
    const login = await post('/api/login',{password:fixture.password}), cookie=login.headers.get('set-cookie').split(';')[0]
    const rpc = async (method,params) => { const data = await (await post('/api/control',{method,params},cookie)).json(); assert.equal(data.kind,'result',JSON.stringify(data.error));return data.result }
    const agent = await rpc('agent.get',{agentKey:'writer'}), rootId=agent.report.roots[0].id
    const waiting = await rpc('root.get',{agentKey:'writer',rootId}); assert.equal(waiting.waits[0].descriptor.kind,'user')
    const answer = await rpc('input.answer',{agentKey:'writer',submissionKey:'built-answer',wait:waiting.waits[0].reference,text:'Markdown'}); assert.equal(answer.reused,false)
    await rpc('host.run',{expectedInstanceId:agent.instanceId}); assert.equal((await rpc('root.get',{agentKey:'writer',rootId})).outcome,'completed')
    const input = await rpc('input.submit',{agentKey:'writer',submissionKey:'built-task',text:'Plain Node task'}); assert.ok(input.inputEventId)
    const first = await rpc('session.events',{target:{kind:'member',agentKey:'writer'},maxEvents:2})
    await rpc('host.run',{expectedInstanceId:agent.instanceId})
    const next = await rpc('session.events',{target:{kind:'member',agentKey:'writer'},maxEvents:2,cursor:first.nextCursor});assert.equal(next.through,first.through)
    await rpc('workflow.resume',{workflowKey:'research',requestKey:'built-resume',reason:'Built acceptance'})
    await rpc('host.run',{expectedInstanceId:agent.instanceId})
    const workflow = await rpc('workflow.get',{workflowKey:'research'});assert.equal(workflow.settled,true);assert.equal(workflow.closed,true);assert.ok(workflow.artifacts.length>0)
    const artifact = await rpc('workflow.artifact',{workflowKey:'research',artifactRef:workflow.artifacts[0].ref});assert.equal(artifact.text,'writer answer')
    const output = await rpc('workflow.output',{workflowKey:'research',nodeKey:'writer'});assert.equal(output.status,'available')
    await fixture.ui.dispose();assert.equal(fixture.service.status,'ready')
  } finally { await fixture.dispose() }
})
