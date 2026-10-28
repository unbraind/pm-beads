/** Span primitives are tested against independent literal byte strings, never a parse/stringify oracle. */
import assert from "node:assert/strict";
import test from "node:test";
import { jsonSourceEntries, replaceJsonField, hasLossyJsonNumbers } from "../json-source.ts";

test("source spans and field changes retain duplicate keys, escaped strings, nested arrays and outer whitespace", () => {
  const raw = ' \t{ "a" : [1,{"quoted":"\\\"\\\\","v":9007199254740993}],"a":-0,"z":1e400 }\r';
  assert.deepEqual(jsonSourceEntries(raw).map(entry => entry.key), ["a", "a", "z"]);
  assert.equal(replaceJsonField(raw, "a", "[]"), raw.replace('"a":-0', '"a":[]'));
  assert.equal(replaceJsonField(raw, "z", undefined), raw.replace(',"z":1e400', ""));
  assert.equal(replaceJsonField('{ "a":1,"a":2,"b":3 }', "a", undefined), '{ "b":3 }');
  assert.equal(replaceJsonField('{ "a":1,"b":2,"a":3 }', "a", undefined), '{ "b":2 }');
  assert.equal(replaceJsonField('{ "a":1,"a":2 }', "a", undefined), '{  }');
  assert.equal(replaceJsonField('{ "a":1 }', "a", undefined), '{  }');
  assert.equal(replaceJsonField('{ "b":0,"a":1,"a":2 }', "a", undefined), '{ "b":0 }');
  assert.equal(replaceJsonField(raw, "missing", undefined), raw);
  assert.equal(replaceJsonField('{ \t"a" : 1  , \t"b" : 2  }', "a", undefined), '{ \t   \t"b" : 2  }');
  assert.equal(replaceJsonField('{ \t"b" : 2  , \t"a" : 1  }', "a", undefined), '{ \t"b" : 2   \t  }');
  assert.equal(replaceJsonField(' { } ', "added", "1"), ' {"added":1 } ');
  assert.equal(replaceJsonField(' { "a":1 } ', "added", "true"), ' { "a":1,"added":true } ');
  assert.equal(jsonSourceEntries("[]").length, 0);
  assert.equal(jsonSourceEntries('[true,false,null,{},[]]').length, 5);
});

test("exact decimal identities admit equivalent spellings and refuse precision loss anywhere in JSON", () => {
  for (const raw of ["0", "0.000", "0e99999999999999999999", "1.00", "10e-1", "-0.5", "1e+3", "1e-10", ' {"x":[null,true,"1e400 -0 \\\"",0.125]} ']) assert.equal(hasLossyJsonNumbers(raw), false, raw);
  for (const raw of ["-0", "-0e10", "1e400", "1e-400", "9007199254740993", "0.1234567890123456789012345", "1.000000000000000000001", '{"x":[0,0.99999999999999999999999]}']) assert.equal(hasLossyJsonNumbers(raw), true, raw);
});
