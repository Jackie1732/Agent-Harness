import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeContextProfile } from '../dist/context/profile.js'
import { decodeContextInput } from '../dist/context/input.js'
import { decodeContextMemory, decodeMemoryRetraction, retrieveSessionMemory } from '../dist/context/memory.js'

export function profile(overrides = {}) {
 return { profileKey:'main',purpose:'generation',previousEventId:null,sections:[],toolNames:[],
  rendererVersion:'context-neutral/v1',historyScope:'local-only',
  tokenAccounting:{mode:'estimate-accepted',algorithm:'neutral-json-utf8-estimate/v1',bytesPerEstimatedToken:4,fixedOverheadEstimate:4},
  budget:{contextWindowTokens:64000,outputReserveTokens:1024,safetyMarginTokens:128,maxRequestBytes:262144,maxAssemblyBytes:1048576,
   maxSourceEvents:10000,maxSourceBytes:32*1024*1024,maxUnits:10000,maxProvenanceEntries:10000,maxMemoryCandidates:1000,
   maxMemoryEstimatedTokens:10000,maxJsonDepth:64,maxJsonNodes:250000,minSavingsBytes:0},...overrides }
}
const id = n => `ah-event:00000000-0000-0000-0000-000000000001:${n}`
const invalid = operation => assert.throws(operation, error => error.code === 'CONTEXT_REQUEST_INVALID')
const input = {kind:'user',origin:'host-authored',originLabel:'test',text:'literal {{ENV}} ${HOME}'}

test('S8-006/007 rejects accessors, proxies, cycles and non-JSON values before evaluation', () => {
 let evaluated = 0
 const getter = {...input};Object.defineProperty(getter,'text',{enumerable:true,get(){evaluated++;return 'hidden'}})
 invalid(()=>decodeContextInput(getter));assert.equal(evaluated,0)
 const proxy = new Proxy(input,{ownKeys(){evaluated++;return Reflect.ownKeys(input)}})
 invalid(()=>decodeContextInput(proxy));assert.equal(evaluated,0)
 for (const value of [NaN,Infinity,undefined,()=>{},new Date(),1n]) invalid(()=>decodeContextInput({...input,text:value}))
 const cycle = {...input};cycle.text=cycle;invalid(()=>decodeContextInput(cycle))
 invalid(()=>decodeContextProfile({...profile(),toolNames:Array(2)}))
 let nested='leaf';for(let n=0;n<1000;n++) nested={nested};invalid(()=>decodeContextInput({...input,text:nested}))
})
test('S8-009/015 literal inputs are frozen, closed, and cannot choose a system role', () => {
 const decoded = decodeContextInput(input)
 assert.deepEqual(decoded,input);assert.ok(Object.isFrozen(decoded));assert.deepEqual(decodeContextInput(decoded),decoded)
 invalid(()=>decodeContextInput({...input,role:'system'}));invalid(()=>decodeContextInput({...input,metadata:{role:'system'}}))
 assert.equal(decoded.text,'literal {{ENV}} ${HOME}')
})
test('S8-011 profile positions and names are unique, sorted by fixed slots rather than locale', () => {
 const section=(name,slot,ordinal)=>({name,slot,ordinal,text:name,originLabel:'test'})
 const p=profile({sections:[section('output','output',1),section('task','task',5),section('rules','rules',9)]})
 const result=decodeContextProfile(p)
 assert.deepEqual(result.sections.map(s=>s.name),['rules','task','output'])
 assert.deepEqual(decodeContextProfile(result),result);assert.ok(Object.isFrozen(result.sections))
 invalid(()=>decodeContextProfile(profile({sections:[section('one','rules',1),section('two','task',1)]})))
 invalid(()=>decodeContextProfile(profile({sections:[section('one','rules',1),section('one','rules',2)]})))
 invalid(()=>decodeContextProfile(profile({sections:[section('one','system',1)]})))
})
test('S8-007/010/043 profile budgets are explicit, bounded, and preserve meaningful zeros', () => {
 const p=profile();p.budget.maxMemoryCandidates=0;p.budget.maxMemoryEstimatedTokens=0
 assert.equal(decodeContextProfile(p).budget.maxMemoryCandidates,0)
 for (const value of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) invalid(()=>decodeContextProfile({...p,budget:{...p.budget,maxRequestBytes:value}}))
 invalid(()=>decodeContextProfile({...p,budget:{...p.budget,maxJsonDepth:10000}}))
 invalid(()=>decodeContextProfile({...p,budget:{...p.budget,outputReserveTokens:p.budget.contextWindowTokens}}))
 invalid(()=>decodeContextProfile({...p,tokenAccounting:{...p.tokenAccounting,bytesPerEstimatedToken:0}}))
 invalid(()=>decodeContextProfile({...p,metadata:{}}))
})
test('S8-009/076 compaction profiles require a task and explicitly prohibit tools', () => {
 const section={name:'summarize',slot:'task',ordinal:0,text:'Summarize as data.',originLabel:'test'}
 invalid(()=>decodeContextProfile(profile({purpose:'compaction'})))
 assert.equal(decodeContextProfile(profile({purpose:'compaction',sections:[section]})).purpose,'compaction')
 invalid(()=>decodeContextProfile(profile({purpose:'compaction',sections:[section],toolNames:['echo']})))
})
test('S8-009/012 memory records and retractions preserve explicit head references', () => {
 const first={key:'note',previousEventId:null,text:'fact',tags:['alpha'],origin:{kind:'host-authored',originLabel:'test',relatedTo:[]}}
 assert.deepEqual(decodeContextMemory(first),first)
 assert.deepEqual(decodeMemoryRetraction({key:'note',previousEventId:id(2),reasonCode:'caller-requested'}),{key:'note',previousEventId:id(2),reasonCode:'caller-requested'})
 invalid(()=>decodeContextMemory({...first,tags:['alpha','alpha']}));invalid(()=>decodeContextMemory({...first,origin:{kind:'system',text:'rule'}}))
 invalid(()=>decodeMemoryRetraction({key:'note',previousEventId:null,reasonCode:'caller-requested'}))
})
test('S8-048 session-tags/v1 uses score, revision and code-unit order, and topK=0 disables selection', () => {
 const head=(key,sequence,tags,active=true)=>({key,headEventId:id(sequence),record:active?{kind:'known',stored:{sequence,eventId:id(sequence)},payload:{key,text:key,tags}}:null})
 const heads=[head('b',2,['x','y']),head('a',2,['x','y']),head('newer',3,['x']),head('retracted',4,['x','y'],false)]
 const result=retrieveSessionMemory(heads,{requiredTags:['x'],queryTags:['x','y'],topK:2})
 assert.deepEqual(result.map(x=>x.key),['a','b','newer'])
 assert.deepEqual(result.map(x=>x.withinTopK),[true,true,false]);assert.deepEqual(result[0].matchedTags,['x','y'])
 assert.deepEqual(retrieveSessionMemory(heads,{requiredTags:[],queryTags:[],topK:0}),[])
 assert.deepEqual(retrieveSessionMemory(heads,{requiredTags:['missing'],queryTags:[],topK:4}),[])
})
