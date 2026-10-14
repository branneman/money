import assert from "node:assert/strict";
import { test } from "node:test";

import { readDelimited } from "./delimited.ts";
import { ImportError } from "./error.ts";

test("a plain table is a header and its rows", () => {
  assert.deepEqual(readDelimited("a;b\r\n1;2\r\n3;4\r\n", ";"), {
    header: ["a", "b"],
    rows: [
      ["1", "2"],
      ["3", "4"],
    ],
  });
});

test("LF ends a row too, and the last row needs no line ending", () => {
  assert.deepEqual(readDelimited("a,b\n1,2\n3,4", ",").rows, [
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("a quoted cell may hold the delimiter, a line break and a doubled quote", () => {
  const text = 'a;b\r\n"one; two";"line\r\nbreak"\r\n"said ""so""";""\r\n';
  assert.deepEqual(readDelimited(text, ";").rows, [
    ["one; two", "line\r\nbreak"],
    ['said "so"', ""],
  ]);
});

test("nothing is trimmed, and empty cells are kept", () => {
  assert.deepEqual(readDelimited("a;b;c\n x ;; \n", ";").rows, [[" x ", "", " "]]);
});

test("an empty last cell without a final line ending is still a cell", () => {
  assert.deepEqual(readDelimited("a;b\n1;", ";").rows, [["1", ""]]);
});

test("a quoted last cell without a final line ending is still a cell", () => {
  assert.deepEqual(readDelimited('a;b\n1;""', ";").rows, [["1", ""]]);
});

test("a single quote is an ordinary character", () => {
  assert.deepEqual(readDelimited("a,b\n'x,y'\n", ",").rows, [["'x", "y'"]]);
});

const refusedWith = (text: string, message: string): void => {
  assert.throws(
    () => readDelimited(text, ";"),
    (error: unknown) => error instanceof ImportError && error.message === message,
  );
};

test("a carriage return that does not end a line is refused, by row", () => {
  refusedWith("a;b\r\n1;2\r3;4\r\n", "row 2 has a carriage return that does not end a line");
  // A file that ends its lines with a carriage return alone. It used to be read as one row.
  refusedWith("a;b\r1;2\r", "row 1 has a carriage return that does not end a line");
  refusedWith('a;b\r\n"1"\r;2\r\n', "row 2 has a carriage return that does not end a line");
});

test("a carriage return inside a quoted cell is data", () => {
  assert.deepEqual(readDelimited('a;b\n"x\ry";2\n', ";").rows, [["x\ry", "2"]]);
});

test("fifty thousand rows are read without trouble", () => {
  const body = Array.from({ length: 50_000 }, (_, index) => `${index};"text; ${index}"`).join("\n");
  const table = readDelimited(`id;text\n${body}\n`, ";");
  assert.equal(table.rows.length, 50_000);
  assert.deepEqual(table.rows[49_999], ["49999", "text; 49999"]);
});

const refused: [string, string, RegExp][] = [
  ["an empty file", "", /^the file is empty$/],
  ["a header and no rows", "a;b\r\n", /^the file has a header and no rows$/],
  [
    "a quote that is never closed",
    'a;b\n1;"two\n3;4\n',
    /^row 2 has a quote that is never closed$/,
  ],
  ["text after a closing quote", 'a;b\n"1"x;2\n', /^row 2 has text after a closing quote$/],
  [
    "a quote inside an unquoted cell",
    'a;b\n1;tw"o\n',
    /^row 2 has a quote inside a cell that is not quoted$/,
  ],
  ["a row with too few cells", "a;b\n1;2\n3\n", /^row 3 has 1 cell, and the header has 2$/],
  ["a row with too many cells", "a;b\n1;2;3\n", /^row 2 has 3 cells, and the header has 2$/],
  ["a blank line in the middle", "a;b\n1;2\n\n3;4\n", /^row 3 has 1 cell, and the header has 2$/],
  [
    "blank lines after the last row",
    "a;b\n1;2\n\n\n",
    /^row 3 has 1 cell, and the header has 2\nrow 4 has 1 cell, and the header has 2$/,
  ],
  ["a header name that is empty", "a;;c\n1;2;3\n", /^column 2 of the header has no name$/],
  [
    "a header name used twice",
    "a;b;a\n1;2;3\n",
    /^columns 1 and 3 of the header have the same name$/,
  ],
];

for (const [label, text, pattern] of refused) {
  test(`refused: ${label}`, () => {
    assert.throws(
      () => readDelimited(text, ";"),
      (error: unknown) => {
        assert.ok(error instanceof ImportError);
        assert.match(error.message, pattern);
        return true;
      },
    );
  });
}

test("a refusal never repeats a header name or a cell", () => {
  const text = "Zqxname;Zqxname\nZqxcell;Zqxcell;Zqxcell\n";
  assert.throws(
    () => readDelimited(text, ";"),
    (error: unknown) => error instanceof ImportError && !error.message.includes("Zqx"),
  );
});

test("a row that spans lines is numbered by its place in the table", () => {
  const text = 'a;b\n"one\ntwo";2\n3\n';
  assert.throws(
    () => readDelimited(text, ";"),
    (error: unknown) => error instanceof ImportError && /^row 3 has 1 cell/.test(error.message),
  );
});
