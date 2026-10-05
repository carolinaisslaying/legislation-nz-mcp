#!/usr/bin/env node
/**
 * Make a LEGISLATION_AUTH_USERS entry:
 *
 *   node dist/auth/cli.js hash-password <username>
 *   docker compose run --rm legislation-mcp node dist/auth/cli.js hash-password <username>
 *
 * Asks for the password twice without echoing it (or reads one line from
 * stdin when piped) and prints `username:hash`. Only the hash is printed; add
 * the line to .env, separating users with commas, and restart the server.
 */

import { createInterface } from "node:readline";
import { hashPassword } from "./passwords.js";
import { isValidUsername } from "./config.js";

const MIN_LENGTH = 12;

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // Echo nothing while the password is typed.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    process.stderr.write(prompt);
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

async function readPiped(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0];
}

async function main(): Promise<number> {
  const [command, rawName] = process.argv.slice(2);
  if (command !== "hash-password" || !rawName) {
    console.error("Usage: node dist/auth/cli.js hash-password <username>");
    return 2;
  }
  const username = rawName.toLowerCase();
  if (!isValidUsername(username)) {
    console.error("Usernames may use a-z, 0-9, _ and -, up to 32 characters.");
    return 2;
  }
  let password: string;
  if (process.stdin.isTTY) {
    password = await askHidden(`Password for ${username}: `);
    if ((await askHidden("Again: ")) !== password) {
      console.error("The passwords did not match.");
      return 1;
    }
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_LENGTH) {
    console.error(`Use at least ${MIN_LENGTH} characters.`);
    return 1;
  }
  console.log(`${username}:${await hashPassword(password)}`);
  console.error("Add this to LEGISLATION_AUTH_USERS in .env (comma-separated), then restart the server.");
  return 0;
}

main().then((code) => process.exit(code));
