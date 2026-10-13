// The characters of a file beyond ASCII, counted. windows-1252 and iso-8859-15 differ in
// eight characters and no check can tell them apart, so the person importing is shown what
// the declared encoding made of the file: a stray "¤" where a "€" belongs is visible here.
export type CharacterCount = { character: string; count: number };

const codeOf = (character: string): number => character.codePointAt(0) ?? 0;

export const nonAscii = (text: string): CharacterCount[] => {
  const counts = new Map<string, number>();
  // Iterating a string yields whole code points, so a pair of surrogates is one character.
  for (const character of text) {
    if (codeOf(character) > 0x7f) counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  return [...counts]
    .map(([character, count]) => ({ character, count }))
    .toSorted((a, b) => codeOf(a.character) - codeOf(b.character));
};

export const describeCharacter = ({ character, count }: CharacterCount): string => {
  const code = codeOf(character).toString(16).toUpperCase().padStart(4, "0");
  return `  U+${code} ${character} ${count}`;
};
