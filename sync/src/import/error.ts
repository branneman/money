import { SyncError } from "../errors.ts";

// A file that is refused. Its message is composed here from row numbers, field names and
// keys, and never repeats a header or a cell, so it may be printed.
export class ImportError extends SyncError {
  override name = "ImportError";
}

const PROBLEM_LIMIT = 20;

// One refusal that lists what was found: enough to see what is wrong with a file, and
// not a line for every row of a file read with the wrong format.
export const reject = (problems: readonly string[]): ImportError => {
  const shown = problems.slice(0, PROBLEM_LIMIT);
  const more = problems.length - shown.length;
  return new ImportError([...shown, ...(more > 0 ? [`and ${more} more`] : [])].join("\n"));
};
