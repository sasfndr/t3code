import { describe, expect, it } from "vite-plus/test";
import { NativeCliConnection } from "./NativeCliConnection.ts";

function fixture(source: string) {
  return new NativeCliConnection({
    command: process.execPath,
    args: ["-e", source],
    cwd: process.cwd(),
    env: process.env,
    onMessage: () => {},
  });
}

describe("NativeCliConnection", () => {
  it("matches concurrent replies by id, including split UTF-8 frames", async () => {
    const connection = fixture(`
      const readline = require('node:readline');
      readline.createInterface({input:process.stdin}).on('line', line => {
        const {id,params} = JSON.parse(line);
        const frame=Buffer.from(JSON.stringify({id,result:params})+'\\n');
        for (const byte of frame) process.stdout.write(Buffer.from([byte]));
      });
    `);
    try {
      expect(
        await Promise.all([connection.request("a", "été"), connection.request("b", 42)]),
      ).toEqual(["été", 42]);
    } finally {
      await connection.close();
    }
  });

  it("rejects outstanding requests when the process exits", async () => {
    const connection = fixture("process.stdin.once('data',()=>process.exit(7))");
    await expect(connection.request("test", {})).rejects.toThrow("closed (7)");
    await connection.close();
    await expect(connection.request("again", {})).rejects.toThrow("closed");
  });

  it("rejects malformed protocol output and closes its owned process", async () => {
    const connection = fixture("process.stdin.once('data',()=>console.log('invalid-json'))");
    await expect(connection.request("test", {})).rejects.toThrow("invalid JSON");
    await connection.close();
  });

  it("times out individual requests without rejecting subsequent work", async () => {
    const connection = fixture(`require('node:readline').createInterface({input:process.stdin})
      .on('line', line => { const r=JSON.parse(line); if(r.method==='answer') console.log(JSON.stringify({id:r.id,result:true})); });`);
    try {
      await expect(connection.request("ignore", {}, 10)).rejects.toThrow("timed out");
      expect(await connection.request("answer", {})).toBe(true);
    } finally {
      await connection.close();
    }
  });
});
