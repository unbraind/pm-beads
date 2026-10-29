/** Review regressions: custody is value-bound, parent graphs are closed, and explicit empties replace receiver state. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient, type PmClientFullMutationOptions } from "@unbrained/pm-cli/sdk";
import { assertBeadsExtensionCustody, captureBeadsExtensions, restoreBeadsExtensions, BeadsSidecarRefusal } from "../sidecar.ts";
import { assertBeadsDialectImportable, BeadsDialectRefusal, type BeadsProducerContract } from "../forecast.ts";
import { assertBeadsParentGraph, BeadsParentRefusal, beadsParentRefusalIssue } from "../parents.ts";
import { allocateBeadsItemId } from "../item-access.ts";
import { ensureBeadIdentityField } from "../identity.ts";
import { pmItemToBead, readAndValidateBeads, assertBeadsImportable, type PmItem } from "../index.ts";
import { acknowledgeBeadsSnapshot, readLiveBeadsSnapshot, planBeadsReconciliation, applyBeadsReconciliation, readBeadsAcknowledgement, reconcileBeadsSnapshots } from "../reconcile.ts";
import { harness, runCommand, runImport, runExport } from "./helpers.ts";

/** Supply registered extension fields through the SDK full mutation options contract. */
async function create(client:PmClient,options:PmClientFullMutationOptions){return client.create(options);}
const basic:BeadsProducerContract={schema:1,producer:"review/v1",fields:[{name:"id",kind:"text"},{name:"title",kind:"text"}]};
const custody:BeadsProducerContract={...basic,fields:[...basic.fields,{name:"vendor",kind:"json"}]};
const hierarchy:BeadsProducerContract={...basic,fields:[...basic.fields,{name:"parent",kind:"text"}]};
/** Seeded deterministic state generator, retained in failure messages. */
function random(seed:number){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return(seed^(seed>>>16))>>>0;};}
/** Synthetic JSONL with deliberately variable whitespace and line endings. */
function jsonl(rows:unknown[],crlf=false){return rows.map(row=>`  ${JSON.stringify(row)} `).join(crlf?"\r\n":"\n");}
/** Require a payload-free dialect refusal rather than an incidental exception. */
function invalid(error:unknown){return error instanceof BeadsDialectRefusal&&error.code==="invalid_snapshot"&&error.remedy.length>15;}

test("512 sidecar state transitions bind custody to present values, deletions and older replayed inputs",()=>{
  const next=random(0x190c057),history:string[]=[];
  for(let sequence=0;sequence<512;sequence++){
    const prior={id:"a",title:"A",...(sequence%4?{vendor:{list:[null,true,next()%100],nested:{revision:sequence}}}:{})};
    const before=jsonl([prior],sequence%2===0),sidecar=captureBeadsExtensions(before,["vendor"]);
    assertBeadsExtensionCustody(before,sidecar,["vendor"]);assertBeadsDialectImportable(before,custody,sidecar);
    const native=jsonl([{id:"a",title:"A"}]);const restored=restoreBeadsExtensions(native,sidecar).text;
    assert.deepEqual(JSON.parse(restored).vendor,prior.vendor);
    const after=jsonl([{id:"a",title:"A",...(sequence%4===1?{}:{vendor:{nested:{revision:sequence+1},list:[false,next()%100]}})}],sequence%2===1);
    assert.throws(()=>assertBeadsExtensionCustody(after,sidecar,["vendor"]),error=>error instanceof BeadsSidecarRefusal&&error.code==="field_conflict");
    assert.throws(()=>assertBeadsDialectImportable(after,custody,sidecar),invalid);
    if(history.length){const oldText=history[next()%history.length],old=captureBeadsExtensions(oldText,["vendor"]);if(!Object.hasOwn(JSON.parse(after),"vendor")&&!Object.hasOwn(JSON.parse(oldText),"vendor"))assertBeadsExtensionCustody(after,old,["vendor"]);else assert.throws(()=>assertBeadsExtensionCustody(after,old,["vendor"]),error=>error instanceof BeadsSidecarRefusal);}
    history.push(before);
  }
  const text=jsonl([{id:"a",title:"A",vendor:{a:1,b:2},unselected:1}]);const sidecar=captureBeadsExtensions(text,["vendor"]);
  assertBeadsExtensionCustody(jsonl([{id:"a",title:"A",vendor:{b:2,a:1},unselected:2}]),sidecar,["vendor"]);
  assertBeadsExtensionCustody('{"id":"a","title":"A"}',captureBeadsExtensions('{"id":"a","title":"A"}',["vendor"]),["vendor"]);
  assert.throws(()=>assertBeadsExtensionCustody(text,captureBeadsExtensions(text,[]),["vendor"]),error=>error instanceof BeadsSidecarRefusal&&error.code==="field_conflict");
  assert.throws(()=>assertBeadsExtensionCustody(text,captureBeadsExtensions(jsonl([{id:"b",title:"B"}]),["vendor"]),["vendor"]),error=>error instanceof BeadsSidecarRefusal&&error.code==="identity_mismatch");
});

test("512 parent graphs agree with an independent closed-graph model, including anonymous, external and legacy identities",()=>{
  const next=random(0x190c1c1e),ids=["A","a","constructor","__proto__","é","e\u0301"];
  for(let sequence=0;sequence<512;sequence++){
    const rows=ids.map(id=>({id,title:id,parent:next()%3?ids[next()%ids.length]:next()%2?"":"missing"}));
    let valid=true;
    for(const row of rows){const seen=new Set<string>();let id:string|undefined=row.id;while(id){if(seen.has(id)){valid=false;break;}seen.add(id);const current=rows.find(row=>row.id===id);if(!current){valid=false;break;}id=current.parent;}}
    const source=jsonl(rows,sequence%2===0);
    if(valid){assertBeadsParentGraph(rows);assertBeadsDialectImportable(source,hierarchy);}
    else{assert.throws(()=>assertBeadsParentGraph(rows),error=>error instanceof BeadsParentRefusal);assert.throws(()=>assertBeadsDialectImportable(source,hierarchy),invalid);}
  }
  const unexpected=new Error("unexpected");assert.throws(()=>beadsParentRefusalIssue(unexpected),error=>error===unexpected);
  assertBeadsParentGraph([]);assertBeadsParentGraph([{id:"a",parent:""}]);
  assertBeadsParentGraph([{id:"a"},{parent:" a "}]);
  assertBeadsParentGraph([{id:"a",parent:"native-parent"}],new Set(["native-parent"]));
  assert.throws(()=>assertBeadsParentGraph([{id:"a",parent:{nested:true}}]),error=>error instanceof BeadsParentRefusal);
  assertBeadsParentGraph([{id:"a",parent:null}]);
});

/** Create a real non-git SDK tracker and clean up only its own scratch data. */
async function receiver(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),"beads-review-")),pmRoot=join(dir,"tracker");t.after(()=>rm(dir,{recursive:true,force:true}));
  const client=new PmClient({pmRoot,noExtensions:true,author:"review-test"});await client.init("sample");await ensureBeadIdentityField(client);
  const ext=await harness();t.after(()=>ext.deactivate());
  const previous=process.env.PATH;process.env.PATH=join(import.meta.dirname,"..","node_modules",".bin")+":"+previous;t.after(()=>{process.env.PATH=previous;});
  return{dir,pmRoot,client,ext};
}

test("native and legacy import refuse missing, cyclic and filtered parents before item writes in every preview mode",async t=>{
  const {dir,pmRoot,client,ext}=await receiver(t),file=join(dir,"source.jsonl"),contract=join(dir,"contract.json");await writeFile(contract,JSON.stringify(hierarchy));
  const before=(await client.listAllComplete()).items;
  for(const rows of [[{id:"a",title:"A",parent:"missing"}],[{id:"a",title:"A",parent:"b"},{id:"b",title:"B",parent:"a"}],[{id:"a",title:"A",parent:"a"}]]){
    await writeFile(file,jsonl(rows));
    for(const command of ["native","beads-import"])for(const options of [{},{"dry-run":true},{"validate-only":true},{dialect:contract}]){
      await assert.rejects(command==="native"?runImport(ext,{pmRoot,args:[file],options}):runCommand(ext,{command,pmRoot,args:[file],options}));
      assert.deepEqual((await client.listAllComplete()).items,before);
    }
    await assert.rejects(assertBeadsImportable(file,pmRoot));
    const report=await readAndValidateBeads(file,pmRoot);assert.equal(report.valid,false);assert(report.issues.some(issue=>issue.code==="invalid_parent_graph"));
  }
  await writeFile(file,jsonl([{id:"a",title:"A",status:"blocked"},{id:"b",title:"B",status:"open",parent:"a"}]));
  await assert.rejects(runImport(ext,{pmRoot,args:[file],options:{"filter-status":"open"}}),error=>error instanceof BeadsParentRefusal);
  assert.deepEqual((await client.listAllComplete()).items,before);
});

test("upsert validates composed receiver ancestry and retains omission semantics, known parent aliases and skipped parents",async t=>{
  const {dir,pmRoot,client,ext}=await receiver(t),file=join(dir,"source.jsonl");
  const a=(await create(client,{title:"A",type:"Task",beadId:"a",unset:["parent"]})).item.id;
  const b=(await create(client,{title:"B",type:"Task",beadId:"b",parent:a})).item.id;
  const before=(await client.listAllComplete()).items;
  await writeFile(file,jsonl([{id:"a",title:"A"}]));await assertBeadsImportable(file,pmRoot);
  await writeFile(file,jsonl([{id:"a",title:"A",parent:"b"},{id:"b",title:"B"}]));
  for(const mode of [{},{"dry-run":true},{"validate-only":true}])await assert.rejects(runImport(ext,{pmRoot,args:[file],options:{upsert:true,...mode}}));
  assert.deepEqual((await client.listAllComplete()).items,before);
  await writeFile(file,jsonl([{id:"new",title:"New",parent:a}]));
  assert.equal((await runImport(ext,{pmRoot,args:[file],options:{"validate-only":true}}) as {valid:boolean}).valid,true);
  assert.equal((await runImport(ext,{pmRoot,args:[file],options:{}})).imported,1);
  const created=(await client.listAllComplete()).items.find(item=>item.bead_id==="new")!;assert.equal(created.parent,a);
  await writeFile(file,jsonl([{id:"new",title:"New",parent:"a"}]));assert.equal((await runImport(ext,{pmRoot,args:[file],options:{upsert:true}})).updated,1);assert.equal((await client.get(created.id)).item.parent,a);
  await writeFile(file,jsonl([{id:"a",title:"Ignored",parent:"b"},{id:"later",title:"Later",parent:"a"}]));assert.equal((await runImport(ext,{pmRoot,args:[file],options:{upsert:true,"merge-strategy":"skip"}})).imported,1);
  assert.equal((await client.get(a)).item.parent,undefined);assert.equal((await client.get(b)).item.parent,a);
  const legacy=(await create(client,{title:"Legacy",type:"Task",description:"[bead_id: legacy]",unset:["parent"]})).item.id;
  await writeFile(file,jsonl([{id:"legacy",title:"Ignored legacy",parent:"a"}]));assert.equal((await runImport(ext,{pmRoot,args:[file],options:{upsert:true,"validate-only":true}}) as {valid:boolean}).valid,true);assert.equal((await runImport(ext,{pmRoot,args:[file],options:{upsert:true}})).skipped,1);assert.equal((await client.get(legacy)).item.parent,undefined);
  await writeFile(file,jsonl([{id:"duplicate",title:"First",parent:"a"},{id:"duplicate",title:"Second",parent:"a"}]));const repeated=await runImport(ext,{pmRoot,args:[file],options:{upsert:true}});assert.equal(repeated.imported,1);assert.equal(repeated.updated,1);
  await writeFile(file,jsonl([{title:"Anonymous",parent:a}]));await runImport(ext,{pmRoot,args:[file],options:{"no-preserve-ids":true}});
  assert.equal((await client.listAllComplete()).items.find(item=>item.title==="Anonymous")!.parent,a);
  await writeFile(file,jsonl([{title:"Anonymous upsert",parent:a}]));await runImport(ext,{pmRoot,args:[file],options:{upsert:true}});assert.equal((await client.listAllComplete()).items.find(item=>item.title==="Anonymous upsert")!.parent,a);
});

test("all label aliases and explicit empty planning values replace SDK state through both import entry points and exports",async t=>{
  const {dir,pmRoot,client,ext}=await receiver(t),file=join(dir,"source.jsonl");
  const parent=(await create(client,{title:"Parent",type:"Task",beadId:"root",unset:["parent"]})).item.id;
  const id=(await create(client,{title:"Target",type:"Task",beadId:"a",parent,tags:'["old"]',assignee:"old",deadline:"2027-01-01",sprint:"old",release:"old"})).item.id;
  for(const command of ["native","beads-import"])for(const label of ["labels","tags"]){
    await client.update(id,{tags:'["old"]',parent,assignee:"old",deadline:"2027-01-01",sprint:"old",release:"old"});
    const row={id:"a",title:"Target",[label]:[],parent:"",assignee:"",deadline:"",sprint:"",release:""};await writeFile(file,jsonl([row]));
    const options={upsert:true,"no-preserve-timestamps":true};
    const result=command==="native"?await runImport(ext,{pmRoot,args:[file],options}):await runCommand(ext,{command,pmRoot,args:[file],options});assert.equal((result as {updated:number}).updated,1);
    const actual=(await client.get(id)).item;assert.deepEqual(actual.tags,[]);
    for(const field of ["parent","assignee","deadline","sprint","release"] as const)assert.equal(actual[field],undefined,field);
    const exported=pmItemToBead(actual as PmItem,new Map(),true);assert.deepEqual(exported.labels,[]);
    await client.update(id,{tags:'["later"]'});await writeFile(file,JSON.stringify(exported));await runImport(ext,{pmRoot,args:[file],options});assert.deepEqual((await client.get(id)).item.tags,[]);
    await client.update(id,{tags:'["preserve"]',assignee:"preserve"});await writeFile(file,jsonl([{id:"a",title:"Target"}]));await runImport(ext,{pmRoot,args:[file],options});assert.deepEqual((await client.get(id)).item.tags,["preserve"]);assert.equal((await client.get(id)).item.assignee,"preserve");
  }
  for(const alias of ["owner","due_date","due_at"]){
    await client.update(id,{assignee:"old",deadline:"2027-01-01"});await writeFile(file,jsonl([{id:"a",title:"Target",[alias]:""}]));
    await runImport(ext,{pmRoot,args:[file],options:{upsert:true}});assert.equal((await client.get(id)).item[alias==="owner"?"assignee":"deadline"],undefined);
  }
  const output=join(dir,"export.jsonl");await client.update(id,{tags:"[]"});await runExport(ext,{pmRoot,options:{output}});const rows=(await readFile(output,"utf8")).split("\n").filter(Boolean).map(line=>JSON.parse(line) as {id:string;labels:string[]});assert.deepEqual(rows.find(row=>row.id==="a")!.labels,[]);
});


test("matching custody survives real SDK import/export/restore while a stale capture refuses before native writes",async t=>{
  const {dir,pmRoot,client,ext}=await receiver(t),file=join(dir,"source.jsonl"),output=join(dir,"export.jsonl");
  const before=jsonl([{id:"a",title:"A"}]),after=jsonl([{id:"a",title:"A",vendor:{nested:[null,false,{value:7}]}}]);
  const stale=captureBeadsExtensions(before,["vendor"]);
  assert.throws(()=>assertBeadsDialectImportable(after,custody,stale),invalid);assert.equal((await client.listAllComplete()).items.length,0);
  const sidecar=captureBeadsExtensions(after,["vendor"]);assertBeadsDialectImportable(after,custody,sidecar);
  await writeFile(file,after);await runImport(ext,{pmRoot,args:[file],options:{"no-preserve-timestamps":true}});await runExport(ext,{pmRoot,options:{output}});
  const restored=restoreBeadsExtensions(await readFile(output,"utf8"),sidecar);assert.deepEqual(JSON.parse(restored.text).vendor,JSON.parse(after).vendor);
});


test("reconciliation refuses invalid effective ancestry before any earlier field or identity write",async t=>{
  const {pmRoot,client}=await receiver(t);
  const a=(await create(client,{title:"A",type:"Task",beadId:"a",unset:["parent"]})).item.id;
  await create(client,{title:"B",type:"Task",beadId:"b",parent:a});
  const before=(await client.listAllComplete()).items,live=await readLiveBeadsSnapshot(pmRoot);
  await acknowledgeBeadsSnapshot(pmRoot,"review",live,"review-test");
  for(const parent of ["missing","b",a]){
    const incoming=structuredClone(live);incoming.find(row=>row.id==="a")!.fields.parent=parent;incoming.find(row=>row.id==="b")!.fields.title="Must remain B";
    const plan=await planBeadsReconciliation(pmRoot,"review",incoming);
    await assert.rejects(applyBeadsReconciliation(pmRoot,plan,"review-test"),error=>error instanceof BeadsParentRefusal);
    assert.deepEqual((await client.listAllComplete()).items,before);
  }
});


test("complete parent previews remain usable before tracker initialization through both import entry points",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"beads-uninitialized-preview-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const ext=await harness();t.after(()=>ext.deactivate());const file=join(dir,"source.jsonl"),pmRoot=join(dir,"missing");
  await writeFile(file,jsonl([{id:"a",title:"A"},{id:"b",title:"B",parent:"a"}]));
  for(const command of ["native","beads-import"])await assert.doesNotReject(async()=>{const options={"validate-only":true};const result=command==="native"?await runImport(ext,{pmRoot,args:[file],options}):await runCommand(ext,{command,pmRoot,args:[file],options});assert.equal((result as {valid:boolean}).valid,true);});
  await assert.rejects(readFile(pmRoot),{code:"ENOENT"});
  await mkdir(pmRoot);assert.equal((await readAndValidateBeads(file,pmRoot)).valid,true);
  assert.equal((await runImport(ext,{pmRoot,args:[file],options:{"validate-only":true}}) as {valid:boolean}).valid,true);
});

test("acyclic parent rewires preserve every link across all input orders and both importer aliases",async t=>{
  const {dir,pmRoot,client,ext}=await receiver(t),file=join(dir,"rewire.jsonl");
  const b=(await create(client,{title:"B",type:"Task",beadId:"b",unset:["parent"]})).item.id;
  const a=(await create(client,{title:"A",type:"Task",beadId:"a",parent:b})).item.id;
  const c=(await create(client,{title:"C",type:"Task",beadId:"c",unset:["parent"]})).item.id;
  const rows=new Map([["a",{id:"a",title:"A",parent:"c"}],["b",{id:"b",title:"B",parent:"a"}],["c",{id:"c",title:"C",parent:""}]]);
  const orders=[["b","a","c"],["b","c","a"],["a","b","c"],["a","c","b"],["c","a","b"],["c","b","a"]];
  for(const command of ["native","beads-import"])for(const order of orders){
    await client.update(b,{unset:["parent"]});await client.update(a,{parent:b});
    const text=jsonl(order.map(id=>rows.get(id)!),order[0]==="b");assertBeadsDialectImportable(text,hierarchy);await writeFile(file,text);
    const options={upsert:true,"no-preserve-timestamps":true};
    const result=command==="native"?await runImport(ext,{pmRoot,args:[file],options}):await runCommand(ext,{command,pmRoot,args:[file],options});
    assert.equal((result as {parents:number}).parents,2,`${command}: ${order.join(",")}`);
    assert.equal((await client.get(a)).item.parent,c);assert.equal((await client.get(b)).item.parent,a);assert.equal((await client.get(c)).item.parent,undefined);
  }
});


test("duplicate target rows compose deferred parent and blocker replacements against SDK reference state, seed 0x190d002",async t=>{
  const {dir,pmRoot,client,ext}=await receiver(t),file=join(dir,"duplicates.jsonl"),next=random(0x190d002);
  const b=(await create(client,{title:"B",type:"Task",beadId:"b",unset:["parent"]})).item.id;
  const c=(await create(client,{title:"C",type:"Task",beadId:"c",unset:["parent"]})).item.id;
  const a=(await create(client,{title:"A",type:"Task",beadId:"a",unset:["parent"]})).item.id;
  const reference=(await create(client,{title:"Reference",type:"Task",unset:["parent"]})).item.id;
  const choices=["b","c","","omit","null"] as const;
  for(let sequence=0;sequence<64;sequence++){
    await client.update(a,{unset:["parent"]});await client.update(reference,{unset:["parent"]});
    const edits=sequence===0?["b",""] as const:sequence===1?["b","omit"] as const:Array.from({length:2+next()%3},()=>choices[next()%choices.length]);
    const rows=[];
    for(const edit of edits){
      const parent=edit==="b"?b:edit==="c"?c:undefined;
      rows.push({id:sequence%2?" a ":"a",title:"A",...(edit==="omit"?{}:{parent:edit==="null"?null:edit?` ${edit} `:"  "}),blocked_by:["b"]});
      if(edit!=="omit"&&edit!=="null")await client.update(reference,parent?{parent}:{unset:["parent"]});
    }
    await writeFile(file,jsonl(rows,sequence%2===0));
    const command=sequence%2?"beads-import":"native",options={upsert:true,"no-preserve-timestamps":true},global={json:sequence%4<2};
    if(sequence%8===0){const preview=command==="native"?await runImport(ext,{pmRoot,args:[file],options:{...options,"validate-only":true},global}):await runCommand(ext,{command,pmRoot,args:[file],options:{...options,"validate-only":true},global});assert.equal((preview as {valid:boolean}).valid,true);}
    const result=command==="native"?await runImport(ext,{pmRoot,args:[file],options,global}):await runCommand(ext,{command,pmRoot,args:[file],options,global});
    const actual=(await client.get(a)).item,expected=(await client.get(reference)).item;
    assert.equal(actual.parent,expected.parent,`sequence ${sequence}: ${edits.join(",")}`);
    assert.equal((result as {parents:number}).parents,expected.parent?1:0);
    assert.equal((result as {dependencies:number}).dependencies,1,"only the effective blocker replacement is reported");
    assert.deepEqual(actual.dependencies?.map(edge=>edge.id),[b]);
  }
  // A target created by the first duplicate follows the same composition rule.
  await writeFile(file,jsonl([{id:"new-duplicate",title:"New",parent:"b"},{id:"new-duplicate",title:"New",parent:""}]));
  await runImport(ext,{pmRoot,args:[file],options:{upsert:true}});
  assert.equal((await client.listAllComplete()).items.find(item=>item.bead_id==="new-duplicate")!.parent,undefined);
});

test("reconciliation keeps external relationship identities through colliding native ids, retained links, both schemas and CLI aliases",async t=>{
  const {dir,pmRoot,client,ext}=await receiver(t),file=join(dir,"collision.jsonl"),planFile=join(dir,"collision-plan.json");
  const a=(await create(client,{title:"A",type:"Task",beadId:"external-a",unset:["parent"]})).item.id;
  const b=(await create(client,{title:"B",type:"Task",beadId:a,unset:["parent"]})).item.id;
  const initial=(await readLiveBeadsSnapshot(pmRoot)).map(({id,fields})=>({id,fields}));
  await acknowledgeBeadsSnapshot(pmRoot,"collisions",initial,"review-test");
  for(let sequence=0;sequence<8;sequence++){
    const live=await readLiveBeadsSnapshot(pmRoot,"collisions",initial),incoming=live.map(({id,fields})=>({id,fields:{...fields}}));
    const target=incoming.find(row=>row.id==="external-a")!;
    if(sequence%2===0)target.fields.parent=sequence%4===0?a:"";
    incoming.find(row=>row.id===a)!.fields.title=`B ${sequence}`;
    if(sequence<4){
      const base=await readBeadsAcknowledgement(pmRoot,"collisions");
      const plan=reconcileBeadsSnapshots(base!,incoming,live,sequence%2?1:2);
      await applyBeadsReconciliation(pmRoot,plan,"review-test");
    }else{
      await writeFile(file,jsonl(incoming.map(row=>({id:row.id,title:row.fields.title,...(row.fields.parent?{parent:row.fields.parent}:{})})),sequence%2===0));
      const command=sequence%2?"beads-reconcile":"beads reconcile",global={json:sequence%2===0,author:"review-test"};
      await runCommand(ext,{command,pmRoot,args:[file],options:{source:"collisions","plan-out":planFile},global});
      await runCommand(ext,{command,pmRoot,options:{source:"collisions","apply-plan":planFile},global});
    }
    assert.equal((await client.get(a)).item.parent,target.fields.parent?b:undefined,`sequence ${sequence}`);
    const unchanged=await planBeadsReconciliation(pmRoot,"collisions",incoming);assert.equal(unchanged.changes.length,0);
  }
});


test("512 duplicate parent graphs validate effective patches rather than superseded edges",()=>{
  const next=random(0x190d0c),ids=["a","b","c"],parents=[...ids,"","missing",undefined,null];
  for(let sequence=0;sequence<512;sequence++){
    const rows: Array<{id:string;parent?:string|null}> = ids.map(id=>({id}));
    const model=new Map<string,string|undefined>(ids.map(id=>[id,undefined]));
    for(let operation=0;operation<9;operation++){
      const id=ids[next()%ids.length],parent=parents[next()%parents.length];rows.push({id,parent});
      if(parent!==undefined&&parent!==null)model.set(id,parent||undefined);
    }
    let valid=true;
    for(const id of ids){const seen=new Set<string>();let cursor:string|undefined=id;while(cursor){if(seen.has(cursor)||!model.has(cursor)){valid=false;break;}seen.add(cursor);cursor=model.get(cursor);}}
    if(valid)assertBeadsParentGraph(rows);else assert.throws(()=>assertBeadsParentGraph(rows),error=>error instanceof BeadsParentRefusal);
  }
  assertBeadsParentGraph([{id:"a",parent:"b"},{id:"a",parent:""},{id:"b",parent:"a"}]);
});

test("import parent namespaces prefer external aliases in either receiver order and superseded cycles clear before linking",async t=>{
  const {dir,pmRoot,client,ext}=await receiver(t),file=join(dir,"namespace.jsonl");
  for(let sequence=0;sequence<2;sequence++){
    const native=await allocateBeadsItemId(pmRoot),external=`external-${sequence}`;
    const createA=()=>create(client,{id:native,title:`A ${sequence}`,type:"Task",beadId:external,unset:["parent"]});
    const createB=()=>create(client,{title:`B ${sequence}`,type:"Feature",beadId:native,unset:["parent"]});
    let b:string;
    if(sequence){await createA();b=(await createB()).item.id;}else{b=(await createB()).item.id;await createA();}
    for(const command of ["native","beads-import"]){
      await writeFile(file,jsonl([{id:external,title:`A ${sequence}`,parent:native}]));
      const options={upsert:true};
      if(command==="native")await runImport(ext,{pmRoot,args:[file],options});else await runCommand(ext,{command,pmRoot,args:[file],options});
      assert.equal((await client.get(native)).item.parent,b);
      await client.update(native,{unset:["parent"]});
      await writeFile(file,jsonl([{id:external,title:`A ${sequence}`,parent:native},{id:external,title:`A ${sequence}`,parent:""},{id:native,title:`B ${sequence}`,parent:external}]));
      const preview=command==="native"?await runImport(ext,{pmRoot,args:[file],options:{...options,"validate-only":true}}):await runCommand(ext,{command,pmRoot,args:[file],options:{...options,"validate-only":true}});assert.equal((preview as {valid:boolean}).valid,true);
      if(command==="native")await runImport(ext,{pmRoot,args:[file],options});else await runCommand(ext,{command,pmRoot,args:[file],options});
      assert.equal((await client.get(native)).item.parent,undefined);assert.equal((await client.get(b)).item.parent,native);
      await client.update(b,{unset:["parent"]});
    }
  }
});
