// The editing of one typed line, apart from the terminal so it can be tested. The input
// arrives in chunks of any size, and a paste can hold several lines: what follows the
// first line break is returned as `rest`, kept for the next read, never dropped.

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";

// skipLineFeed: the line ended in a carriage return that was the last character of the
// chunk, so a line feed first in the next chunk is the other half of the same break. The
// caller hands it back on the next call.
export type Split = { line: string | null; rest: string; aborted: boolean; skipLineFeed: boolean };

export const splitInput = (pending: string, chunk: string, skipLineFeed = false): Split => {
  let line = "";
  const text = pending + chunk;
  // Whole characters, so that backspace removes what was typed and not half of it.
  const keys = Array.from(skipLineFeed && text.startsWith("\n") ? text.slice(1) : text);
  for (let at = 0; at < keys.length; at += 1) {
    const key = keys[at];
    if (key === CTRL_C || key === CTRL_D) {
      return { line: null, rest: "", aborted: true, skipLineFeed: false };
    }
    if (key === "\r" || key === "\n") {
      const joined = key === "\r" && keys[at + 1] === "\n";
      return {
        line,
        rest: keys.slice(at + (joined ? 2 : 1)).join(""),
        aborted: false,
        skipLineFeed: key === "\r" && at === keys.length - 1,
      };
    }
    if (key === BACKSPACE) line = Array.from(line).slice(0, -1).join("");
    else line += key;
  }
  // Without a break the edited text is what is kept, so a backspace is not applied twice.
  // An empty read changes nothing, so the wait for a line feed carries over it.
  return {
    line: null,
    rest: line,
    aborted: false,
    skipLineFeed: skipLineFeed && text === "",
  };
};
