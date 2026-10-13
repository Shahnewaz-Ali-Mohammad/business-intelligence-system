import test from "node:test";
import assert from "node:assert/strict";
import { coverageTools, generationBatches, coverageReport } from "./coverage.mjs";
import { compileTool } from "./model.mjs";
const catalog = {
  objects: [
    {
      id: "tickets",
      schema: "dbo",
      name: "Tickets",
      kind: "table",
      columns: [
        { name: "LinkId", dataType: "int", isPrimaryKey: true },
        { name: "Subject", dataType: "varchar" },
      ],
    },
  ],
  relationships: [],
};
test("compact tools support variable fields, null predicates and grouped metrics in all dialects", () => {
  const tools = coverageTools(catalog);
  assert.equal(tools.length, 2);
  for (const dialect of ["postgres", "mysql", "sqlserver"]) {
    const rows = compileTool(tools[0], catalog, dialect, {
      query: JSON.stringify({
        columns: ["tickets:LinkId"],
        filters: [
          {
            field: "tickets:LinkId",
            operator: "not_null",
            parameter: "link",
            required: false,
          },
        ],
      }),
    });
    assert.match(rows.sql, /IS NOT NULL/);
    const aggregate = compileTool(tools[1], catalog, dialect, {
      query: JSON.stringify({
        groupBy: ["tickets:Subject"],
        metrics: [{ field: null, operation: "count", alias: "tickets" }],
      }),
    });
    assert.match(aggregate.sql, /GROUP BY/);
    assert.throws(
      () =>
        compileTool(tools[0], catalog, dialect, {
          query: JSON.stringify({ columns: ["tickets:Unknown"] }),
        }),
      /capabilities/,
    );
    assert.throws(() =>
      compileTool(tools[0], catalog, dialect, {
        query: JSON.stringify({ sql: "DELETE FROM Tickets" }),
      }),
    );
  }
});
test("wide tables retain all allowed fields without multiplying tools", () => {
  const wide = {
    ...catalog,
    objects: [
      {
        ...catalog.objects[0],
        columns: Array.from({ length: 201 }, (_, i) => ({
          name: `field${i}`,
          dataType: "int",
        })),
      },
    ],
  };
  const tools = coverageTools(wide);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].capabilities.fields.length, 201);
  assert.doesNotThrow(() =>
    compileTool(tools[0], wide, "postgres", {
      query: JSON.stringify({ columns: ["tickets:field200"] }),
    }),
  );
});

test('ordinary selected tables are generated together with all fields and relationships', () => {
 const from={...catalog.objects[0],columns:Array.from({length:60},(_,i)=>({name:`Field${i}`,dataType:'int'}))};
 const to={...from,id:'customers',name:'Customers'};
 const relationship={id:'link',from:from.id,to:to.id,targetUnique:true,columns:[{from:'Field0',to:'Field0'}]};
 const selection={objects:[from,to],relationships:[relationship]};
 const batches=generationBatches(selection);
 assert.equal(batches.length,1); assert.equal(batches[0].objects.flatMap(o=>o.columns).length,120);
 assert.deepEqual(batches[0].relationships,[relationship]);
});
test('large selections still cover every selected field after batching',()=>{
 const large={...catalog,objects:[{...catalog.objects[0],columns:Array.from({length:250},(_,i)=>({name:`Field${i}`,dataType:'int'}))}]};
 const batches=generationBatches(large);
 assert.equal(batches.length,3);
 assert.equal(new Set(batches.flatMap(b=>b.objects.flatMap(o=>o.columns.map(c=>c.name)))).size,250);
});

test('reusable scenarios cover a multi-hop path in both directions without enumerating queries',()=>{
 const object=(id,key,extra)=>({id,schema:'dbo',name:id,kind:'table',columns:[{name:key,dataType:'int',isPrimaryKey:true},...extra.map(name=>({name,dataType:'int'}))]});
 const graph={objects:[object('customers','CustomerID',[]),object('bills','BillID',['CustomerID']),object('lines','LineID',['BillID','Amount'])],relationships:[{id:'customer_bills',from:'bills',to:'customers',targetUnique:true,columns:[{from:'CustomerID',to:'CustomerID'}]},{id:'bill_lines',from:'lines',to:'bills',targetUnique:true,columns:[{from:'BillID',to:'BillID'}]}]};
 const tools=coverageTools(graph);assert.equal(tools.length,6);
 const tool=tools.find(t=>t.base==='customers'&&t.mode==='aggregate');
 const compiled=compileTool(tool,graph,'sqlserver',{query:JSON.stringify({groupBy:['customers:CustomerID'],metrics:[{field:'lines:Amount',operation:'sum',alias:'amount'}]})});
 assert.deepEqual(compiled.joinIds,['customer_bills','bill_lines']);
 const report=coverageReport(graph,tools);assert.equal(report.totalFields,6);assert.equal(report.verifiedRelationships,2);assert.equal(report.gaps.length,0);
});
