import { createHash, timingSafeEqual } from "node:crypto";

import type { Config } from "@money/shared";

import { isStrongEnough, parseHash } from "./auth/password.ts";
import type { PasswordHash } from "./auth/password.ts";

export type Person = { key: string; username: string; password: PasswordHash };

// What the server needs beyond what the sync's validator accepts. Messages name a person
// by position, never by key or username: a key is a first name.
export const serverConfigProblems = (config: Config): string[] => {
  const problems: string[] = [];
  const people = Object.entries(config.people ?? {});
  if (people.length === 0) problems.push("people names no one");
  for (const [index, [, person]] of people.entries()) {
    const hash = parseHash(person.password);
    if (hash === null) {
      problems.push(`people, entry ${index + 1}: password is not a hash money hash-password made`);
    } else if (!isStrongEnough(hash)) {
      problems.push(`people, entry ${index + 1}: password hash is weaker than this server accepts`);
    }
  }
  for (const [key, account] of Object.entries(config.accounts)) {
    if (account.owners === undefined) problems.push(`accounts.${key}: names no owner`);
  }
  return problems;
};

// Only called once serverConfigProblems is empty, so every hash parses.
export const peopleOf = (config: Config): Person[] =>
  Object.entries(config.people ?? {}).map(([key, person]) => {
    const password = parseHash(person.password);
    if (password === null) throw new Error("a password hash does not parse");
    return { key, username: person.username, password };
  });

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

// Compares the digests of all of them, so how long it takes says nothing about which
// username, or how much of one, was right.
export const findByUsername = (people: readonly Person[], username: string): Person | null => {
  const typed = digest(username);
  let found: Person | null = null;
  for (const person of people) {
    if (timingSafeEqual(typed, digest(person.username)) && found === null) found = person;
  }
  return found;
};

export const visibleAccounts = (config: Config, personKey: string): string[] =>
  Object.entries(config.accounts)
    .filter(([, account]) => account.owners?.includes(personKey) === true)
    .map(([key]) => key)
    .sort();
