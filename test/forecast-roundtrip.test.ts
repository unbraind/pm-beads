/** Every exact source field and alias passes an actual import/export round trip against SDK-normalized reference state. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient, preserveMutationStdinTokenFields, type PmClientFullMutationOptions } from "@unbrained/pm-cli/sdk";
import { forecastBeadsDialect, assertBeadsDialectImportable, type BeadsProducerContract } from "../forecast.ts";
import { canonicalBeadsRecord, type BeadsItem } from "../index.ts";
import { harness, runExport, runImport } from "./helpers.ts";

/** Observe native SDK fields, translating only generated relationship identities between trackers. */
async function state(client: PmClient): Promise<unknown> {
  const rows=(await client.listAllComplete()).items, external=new Map(rows.map(row=>[row.id,String(row.bead_id ?? row.title)]));
  return rows.map(row=>({id:external.get(row.id),title:row.title,description:row.description,type:row.type,status:row.status,priority:row.priority,tags:row.tags,
    assignee:row.assignee,parent:row.parent?external.get(row.parent):undefined,deadline:row.deadline,sprint:row.sprint,release:row.release,
    dependencies:row.dependencies?.map(edge=>({id:external.get(edge.id),kind:edge.kind}))})).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
}

test("all 17 claimed exact fields/aliases round-trip against SDK read-back under ambient focus and CRLF", async t=>{
  const dir=await mkdtemp(join(tmpdir(),"beads-dialect-roundtrip-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const ext=await harness();t.after(()=>ext.deactivate());const previous=process.env.PATH;process.env.PATH=join(import.meta.dirname,"..","node_modules",".bin")+":"+previous;t.after(()=>{process.env.PATH=previous;});
  const covered=new Set<string>();
  for(let variant=0;variant<6;variant++) {
    const source=join(dir,`source-${variant}`),target=join(dir,`target-${variant}`),oracleRoot=join(dir,`oracle-${variant}`);
    const receiver=new PmClient({pmRoot:target,noExtensions:true,author:"roundtrip"}),oracle=new PmClient({pmRoot:oracleRoot,noExtensions:true,author:"roundtrip"});
    await receiver.init("model");await oracle.init("model");
    const title=variant%2?"name":"title",labels=variant%2?"tags":"labels",assignee=variant%2?"owner":"assignee",deadline=["deadline","due_date","due_at"][variant%3],dependencies=variant%2?"blocked_by":"dependencies";
    const contract:BeadsProducerContract={schema:1,producer:`alias-fixture/v${variant}`,fields:[{name:"id",kind:"text"},{name:title,kind:"text"},{name:"description",kind:"text"},
      {name:"priority",kind:"priority"},{name:labels,kind:"labels"},{name:assignee,kind:"text"},{name:"parent",kind:"text"},{name:deadline,kind:"text"},
      {name:"sprint",kind:"text"},{name:"release",kind:"text"},{name:dependencies,kind:"blockers"}]};
    for(const field of forecastBeadsDialect(contract).fields){assert.equal(field.fidelity,"exact");covered.add(field.field);}
    const description=variant%2?"  first\r\nsecond\r\n":"\n  native text  \n";
    const rows=[{id:"a",[title]:"a",description:"root"},{id:"b",[title]:" b ",description,priority:variant%5,[labels]:["beta","alpha"],
      [assignee]:" synthetic-agent ",parent:"a",[deadline]:"2027-01-02",sprint:"s",release:"r",[dependencies]:["a"]}];
    const text=rows.map(row=>JSON.stringify(row)).join(variant%2?"\r\n":"\n");
    assert.equal(assertBeadsDialectImportable(text,contract).importable,true);
    const contractFile=join(dir,`contract-${variant}.json`);await writeFile(contractFile,JSON.stringify(contract));await writeFile(source,text);
    // A real ambient focus must not become a source item's implicit parent.
    const rootOptions:PmClientFullMutationOptions={title:"a",description:"root",type:"Task",status:"open",priority:2,tags:"[]",unset:["parent","assignee","deadline","sprint","release"],dep:[]};
    const root=(await oracle.create(rootOptions)).item;await oracle.focus(root.id);
    const childOptions:PmClientFullMutationOptions={title:" b ",description,type:"Task",status:"open",priority:variant%5,tags:JSON.stringify(["beta","alpha"]),
      assignee:" synthetic-agent ",parent:root.id,deadline:"2027-01-02",sprint:"s",release:"r",dep:[`id=${JSON.stringify(root.id)},kind=blocked_by,author=roundtrip`]};
    await oracle.create(preserveMutationStdinTokenFields(childOptions,["description"]));
    const result=await runImport(ext,{pmRoot:target,args:[source],options:{dialect:contractFile,"no-preserve-timestamps":true}});assert.equal(result.imported,2);
    assert.deepEqual(await state(receiver),await state(oracle));
    const receiverRoot=(await receiver.listAllComplete()).items.find(item=>item.bead_id==="a")!;await receiver.focus(receiverRoot.id);
    const before=await state(receiver),output=join(dir,`export-${variant}.jsonl`);await runExport(ext,{pmRoot:target,options:{output}});
    const exported=(await readFile(output,"utf8")).split("\n").filter(Boolean).map(line=>JSON.parse(line) as BeadsItem);
    for(const row of exported) {
      const input=rows.find(input=>input.id===row.id)!,expected=canonicalBeadsRecord(input),actual=canonicalBeadsRecord(row);
      for(const field of forecastBeadsDialect(contract).fields) if(Object.hasOwn(input,field.field)) {
        if(field.target==="id") assert.equal(actual.id,expected.id);
        else assert.equal(actual.fields[field.target as keyof typeof actual.fields],expected.fields[field.target as keyof typeof expected.fields],field.field);
      }
    }
    await runImport(ext,{pmRoot:target,args:[output],options:{upsert:true,"no-preserve-timestamps":true}});assert.deepEqual(await state(receiver),before);
  }
  assert.equal(covered.size,17);
});
