/** Deterministic producer-contract forecasts, boundary fuzzing and guard equivalence. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, rm, mkdir, cp, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { forecastBeadsDialect, assertBeadsDialectImportable, assertBeadsDialectForecast, parseBeadsProducerContract, readBeadsProducerContract, beadsDialectRefusalReceipt, BeadsDialectRefusal,
  type BeadsProducerContract } from "../forecast.ts";
import { captureBeadsExtensions } from "../sidecar.ts";
import { harness, runCommand, runImport } from "./helpers.ts";
import { PmClient, printResult } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";

const minimal: BeadsProducerContract = {schema:1,producer:"minimal/v1",fields:[{name:"id",kind:"text"},{name:"title",kind:"text"}]};
const row = '{"id":"a","title":" A "}';
/** Assert stable failure categories and safe remedies. */
function refused(code: string) { return (error: unknown) => error instanceof BeadsDialectRefusal && error.code === code && error.exitCode === 2 && error.remedy.length > 15; }
/** Render with the actual host wire encoder. */
function render(value: unknown, json: boolean): string {
  const previous = process.stdout.write, chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { printResult(value, {json}); } finally { process.stdout.write = previous; }
  return chunks.join("");
}

test("two named fixture contracts deterministically forecast all fields in compact TOON and JSON", async () => {
  const canonical = parseBeadsProducerContract(await readFile(new URL("./fixtures/dialects/canonical.json", import.meta.url), "utf8"));
  const extended = parseBeadsProducerContract(await readFile(new URL("./fixtures/dialects/extended.json", import.meta.url), "utf8"));
  for (const [contract, expected] of [[canonical,{exact:11,sidecarDependent:0,unsupported:0}],[extended,{exact:1,sidecarDependent:1,unsupported:4}]] as const) {
    const before = structuredClone(contract), forecast = forecastBeadsDialect(contract);
    assert.deepEqual(forecast.counts, expected); assert.deepEqual(contract,before);
    assert.deepEqual(forecastBeadsDialect({...contract,fields:[...contract.fields].reverse()}),forecast);
    assert.deepEqual(parseBeadsProducerContract(JSON.stringify(contract)),contract);
    assert.deepEqual(JSON.parse(render(forecast,true)),forecast);
    assert.deepEqual(decodeToon(render(forecast,false)),forecast);
    assert(Buffer.byteLength(render(forecast,false)) < 7000);
  }
  assert.throws(()=>assertBeadsDialectImportable('{"id":"a","title":{"text":"A"}}',extended),refused("unsupported_dialect"));
});

test("strict contract must-refuse corpus and released native shapes remain opt-in", () => {
  const sparse = Array(2); sparse[1]={name:"id",kind:"text"};
  for (const input of [null,[],{}, {...minimal,schema:2},{...minimal,extra:true},{...minimal,producer:1},{...minimal,producer:" "},
    {...minimal,producer:"bad producer"},{...minimal,fields:sparse},{...minimal,fields:[...minimal.fields,minimal.fields[0]]},
    {...minimal,fields:[{name:"id",kind:"text"}]},{...minimal,fields:[...minimal.fields,{name:"",kind:"text"}]},
    {...minimal,fields:[...minimal.fields,{name:"bad field",kind:"text"}]}, {...minimal,fields:Array.from({length:65},(_,i)=>({name:`f${i}`,kind:"text"}))},
    {...minimal,fields:[...minimal.fields,{name:"x",kind:Infinity}]},{...minimal,producer:"x".repeat(129)}]) assert.throws(()=>forecastBeadsDialect(input),refused("invalid_contract"));
  for (const text of ["{",'null',JSON.stringify({...minimal,schema:Infinity}),'"x"',JSON.stringify(minimal).replace('"schema":1','"schema":1,"schema":1'),
    JSON.stringify(minimal).replace('"name":"id"','"name":"id","name":"id"'), " ".repeat(65537)]) assert.throws(()=>parseBeadsProducerContract(text),refused("invalid_contract"));
  assert.throws(()=>parseBeadsProducerContract(null as unknown as string),refused("invalid_contract"));
  assert.equal(assertBeadsDialectImportable(row,minimal).importable,true);
  const aliases={...minimal,fields:[{name:"id",kind:"text"},{name:"name",kind:"text"}]} as BeadsProducerContract;
  assert.equal(assertBeadsDialectImportable('{"id":"a","name":"Old native alias"}',aliases).counts.exact,2);
});

test("aliases cannot silently shadow each other; native timestamps, custom statuses and sensitive opaque fields stay unsupported", () => {
  for (const name of ["name","created_at","updated_at","closed_at","completed_at","close_reason","resolution","state_reason","status","type","issue_type","blocks","vendor.nested","apiToken","constructor"]) {
    const contract={...minimal,fields:[...minimal.fields,{name,kind:"text" as const}]};
    const report=forecastBeadsDialect(contract);
    assert(report.counts.unsupported>0,name);assert.equal(report.importable,false);
  }
  const unexpected=new Error("unexpected");assert.throws(()=>beadsDialectRefusalReceipt(unexpected),error=>error===unexpected);
  const empty={...minimal,fields:[]};assert.throws(()=>forecastBeadsDialect(empty),refused("invalid_contract"));
  assert.throws(()=>forecastBeadsDialect({...minimal,fields:[...minimal.fields,{name:"title",kind:"text"}]}),refused("invalid_contract"));
});

test("sidecar-dependent fields reuse actual capture/restore validation and demand custody before import", () => {
  const contract={...minimal,fields:[...minimal.fields,{name:"vendor",kind:"json" as const}]};
  const text=JSON.stringify({id:"a",title:"A",vendor:{nested:[null,1,true,{label:"value"}]}}), sidecar=captureBeadsExtensions(text,["vendor"]);
  assert.equal(forecastBeadsDialect(contract).counts.sidecarDependent,1);
  assert.throws(()=>assertBeadsDialectImportable(text,contract),refused("sidecar_required"));
  assert.throws(()=>assertBeadsDialectImportable(text,contract,captureBeadsExtensions(text,[])),refused("sidecar_required"));
  assert.equal(assertBeadsDialectImportable(text,contract,sidecar).importable,true);
  assert.throws(()=>assertBeadsDialectImportable(text,contract,{...sidecar,digest:"bad"}),refused("invalid_snapshot"));
  const different=text.replace('"id":"a"','"id":"b"');assert.throws(()=>assertBeadsDialectImportable(different,contract,sidecar),refused("invalid_snapshot"));
});

test("snapshot boundary rejects nesting, undeclared fields, numeric extremes and malformed rows before import", () => {
  const contract={...minimal,fields:[...minimal.fields,{name:"priority",kind:"priority" as const},{name:"labels",kind:"labels" as const}]};
  for(const text of ['{', '{"id":"a","title":{"text":"A"}}','{"id":"a","title":"A","other":1}',
    '{"id":"a","title":"A","priority":1e400}', '{"id":"a","title":"A","priority":1.5}',
    '{"id":"a","title":"A","priority":"2"}', '{"id":"a","title":"A","priority":-1}', '{"id":"a","title":"A","priority":5}',
    '{"id":"a","title":"A","labels":[1]}', '{"id":"a","title":"A","labels":{}}',
    '{"id":"a","title":"A","dependencies":["missing"]}']) assert.throws(()=>assertBeadsDialectImportable(text,contract),refused("invalid_snapshot"));
  for(const priority of [0,1,2,3,4]) assert.equal(assertBeadsDialectImportable(JSON.stringify({id:"a",title:"A",priority,labels:["x"]}),contract).importable,true);
  for(const count of [NaN,Infinity,-Infinity,-1,0.5,65,Number.MAX_VALUE]) {
    const report=forecastBeadsDialect(minimal);report.counts.exact=count;assert.throws(()=>assertBeadsDialectForecast(report),refused("invalid_contract"));
  }
  const report=forecastBeadsDialect(minimal);report.counts.exact=0;assert.throws(()=>assertBeadsDialectForecast(report),refused("invalid_contract"));
  const huge=forecastBeadsDialect(minimal);huge.fields[0].remedy="x".repeat(32768);assert.throws(()=>assertBeadsDialectForecast(huge),refused("invalid_contract"));
});

test("bounded contract file I/O, CLI receipts and both importer guards work without git", async t => {
  const dir=await mkdtemp(join(tmpdir(),"beads-forecast-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,"producer.json"), source=join(dir,"source.jsonl");
  await writeFile(file,JSON.stringify(minimal));await writeFile(source,row);
  assert.deepEqual(await readBeadsProducerContract(file),minimal);
  await assert.rejects(readBeadsProducerContract(join(dir,"absent")),refused("io_error"));
  await assert.rejects(readBeadsProducerContract(dir),refused("io_error"));
  await writeFile(join(dir,"large")," ".repeat(65537));await assert.rejects(readBeadsProducerContract(join(dir,"large")),refused("io_error"));
  await writeFile(join(dir,"malformed"),"{");await assert.rejects(readBeadsProducerContract(join(dir,"malformed")),refused("invalid_contract"));
  const ext=await harness();t.after(()=>ext.deactivate());
  assert.deepEqual(await runCommand(ext,{command:"beads forecast",args:[file]}),forecastBeadsDialect(minimal));
  const exitCode=process.exitCode;
  try {
    for(const args of [[],[file,file],[" "],[join(dir,"absent")]]) {
      const receipt=await runCommand(ext,{command:"beads forecast",args}) as {refused:boolean};assert.equal(receipt.refused,true);assert.equal(process.exitCode,2);process.exitCode=exitCode;
    }
  } finally {process.exitCode=exitCode;}
  const pmRoot=join(dir,"tracker"),client=new PmClient({pmRoot,noExtensions:true,author:"forecast-test"});await client.init("sample");
  const unsupported={...minimal,fields:[...minimal.fields,{name:"title.nested",kind:"text"}]};await writeFile(file,JSON.stringify(unsupported));
  for(const command of ["native","beads-import"]) {
    const opts={pmRoot,args:[source],options:{dialect:file}};
    await assert.rejects(command==="native"?runImport(ext,opts):runCommand(ext,{...opts,command}),refused("unsupported_dialect"));
    assert.equal((await client.listAllComplete()).items.length,0);
  }
  for(const dialect of [" ",false,42]) await assert.rejects(runImport(ext,{pmRoot,args:[source],options:{dialect}}),refused("invalid_contract"));
  await writeFile(file,JSON.stringify(minimal));
  const oldPath=process.env.PATH;process.env.PATH=join(import.meta.dirname,"..","node_modules",".bin")+":"+oldPath;
  try {
    const result=await runImport(ext,{pmRoot,args:["--dialect",file,source],options:{dialect:file,"no-preserve-timestamps":true}});
    assert.equal(result.imported,1);assert.equal((await client.listAllComplete()).items.length,1);
    assert.equal((await client.listAllComplete()).items[0].title,"A");
  } finally {process.env.PATH=oldPath;}
});


test("512 seeded producer contracts validate and emit finite deterministic forecasts over their whole declared field domain",()=>{
  let seed=0x291026;
  for(let sequence=0;sequence<512;sequence++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const kinds=["text","priority","labels","blockers","json"] as const;
    const contract:BeadsProducerContract={...minimal,producer:`seeded/v${sequence}`,fields:[...minimal.fields,
      ...Array.from({length:seed%63},(_,index)=>({name:`extension_${index}`,kind:kinds[(seed+index)%kinds.length]}))]};
    const produced=JSON.stringify(contract),parsed=parseBeadsProducerContract(produced),report=forecastBeadsDialect(parsed);
    assertBeadsDialectForecast(report);assert.deepEqual(forecastBeadsDialect({...parsed,fields:[...parsed.fields].reverse()}),report);
    assert.equal(report.counts.exact,2);assert.equal(report.counts.sidecarDependent,contract.fields.length-2);assert.equal(report.counts.unsupported,0);
    for(const value of Object.values(report.counts)){assert(Number.isSafeInteger(value));assert(value>=0&&value<=64);}
  }
});

test("compiled forecast JSON/TOON succeeds with git absent and leaves a non-git tracker unchanged",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"beads-forecast-nogit-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=resolve(import.meta.dirname,".."),pmRoot=join(dir,"tracker"),client=new PmClient({pmRoot,noExtensions:true,author:"forecast"});await client.init("sample");
  const before=(await client.listAllComplete()).items,extension=join(pmRoot,"extensions","pm-beads");await mkdir(extension,{recursive:true});
  for(const entry of ["dist","package.json","manifest.json"])await cp(join(root,entry),join(extension,entry),{recursive:true});
  await symlink(join(root,"node_modules"),join(extension,"node_modules"),"junction");
  const contractFile=join(dir,"producer.json");await writeFile(contractFile,JSON.stringify(minimal));
  for(const format of ["json","toon"]) {
    const result=spawnSync(process.execPath,[join(root,"node_modules/@unbrained/pm-cli/dist/cli.js"),"--path",pmRoot,...(format==="json"?["--json"]:[]),"beads","forecast",contractFile],{
      cwd:dir,encoding:"utf8",env:{...process.env,PATH:"",GIT_CEILING_DIRECTORIES:tmpdir()},timeout:30000});
    assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(format==="json"?JSON.parse(result.stdout):decodeToon(result.stdout),forecastBeadsDialect(minimal));
  }
  assert.deepEqual((await client.listAllComplete()).items,before);
});


test("blocker domain refuses hidden native nesting and non-blocker edges instead of forecasting silent loss",()=>{
  const contract:BeadsProducerContract={...minimal,fields:[...minimal.fields,{name:"dependencies",kind:"blockers"}]};
  const root={id:"a",title:"A"};
  for(const edge of [{id:"a",kind:"blocked_by",vendor:{nested:1}},{id:"a",kind:"related_to"},{issue_id:"a"}," "]) {
    const text=[root,{id:"b",title:"B",dependencies:[edge]}].map(row=>JSON.stringify(row)).join("\n");
    assert.throws(()=>assertBeadsDialectImportable(text,contract),refused("invalid_snapshot"));
  }
  assert.throws(()=>assertBeadsDialectImportable(JSON.stringify({...root,dependencies:null}),contract),refused("invalid_snapshot"));
  for(const edge of ["a",{id:"a",kind:"blocked_by"},{issue_id:"b",depends_on_id:"a",type:"blocks"}]) {
    const text=[root,{id:"b",title:"B",dependencies:[edge]}].map(row=>JSON.stringify(row)).join("\n");
    assert.equal(assertBeadsDialectImportable(text,contract).importable,true);
  }
  const blocked:BeadsProducerContract={...minimal,fields:[...minimal.fields,{name:"blocked_by",kind:"blockers"}]};
  assert.equal(assertBeadsDialectImportable(JSON.stringify(root)+"\n"+JSON.stringify({id:"b",title:"B",blocked_by:"a"}),blocked).importable,true);
});
