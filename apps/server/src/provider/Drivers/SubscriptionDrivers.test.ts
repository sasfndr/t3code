import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { KimiDriver } from "./KimiDriver.ts";
import { MuseDriver } from "./MuseDriver.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-subscription-drivers-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const instanceId = ProviderInstanceId.make("subscription-test");
const threadId = ThreadId.make("subscription-test");
const executable = (source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-protocol-fixture-" });
    const binaryPath = `${dir}/cli`;
    yield* fs.writeFileString(binaryPath, `#!${process.execPath}\n${source}`);
    yield* fs.chmod(binaryPath, 0o700);
    return binaryPath;
  });
const kimi = `
if(process.argv.includes('provider')) {console.log(JSON.stringify({models:{k3:{displayName:'K3',supportEfforts:['low','high']}}}));process.exit(0);}
const lines=require('node:readline').createInterface({input:process.stdin});
let prompt;
const send=(value)=>console.log(JSON.stringify(value));
lines.on('line',line=>{
 const r=JSON.parse(line); const reply=result=>send({id:r.id,result});
 if(r.method==='initialize') return reply({agentInfo:{version:'fixture'}});
 if(r.method==='session/new'||r.method==='session/load') return reply({sessionId:r.params.sessionId||'native-session',configOptions:[{category:'model',id:'model',currentValue:'k3',options:[{value:'k3',name:'K3'}]},{category:'thought_level',id:'thinking',options:[{value:'low',name:'Low'}]}]});
 if(r.method==='session/set_config_option') {if(!['model','thinking','mode'].includes(r.params.configId)) return send({id:r.id,error:{code:-32602,message:'Unknown configId'}}); return reply({});}
 if(r.method==='session/prompt') {prompt=r;send({id:88,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'permission',title:'Write test file',kind:'edit'},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}});return;}
 if(r.id===88) {send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:r.result.outcome.optionId==='yes'?'APPROVED':'DENIED'}}}});send({id:prompt.id,result:{stopReason:'end_turn'}});return;}
 if(r.method==='session/cancel'&&prompt) return send({id:prompt.id,result:{stopReason:'cancelled'}});
});`;
const muse = `
const fs=require('node:fs');
if(process.argv.includes('serve')) {
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize') console.log(JSON.stringify({id:r.id,result:{serverInfo:{version:'fixture'}}}));if(r.method==='model/list') console.log(JSON.stringify({id:r.id,result:{models:[{modelId:'spark',displayLabel:'Spark',isDefault:true,variants:['low','high']}]}}));});
} else {
 const prompt=fs.readFileSync(process.argv[process.argv.indexOf('--prompt-file')+1],'utf8');
 if(!process.argv.includes('--no-session-log')) process.exit(4);
 if(prompt.includes('WAIT_FOR_STOP')) setInterval(()=>{},1000);
 else process.stdout.write(JSON.stringify({payload_type:'run.terminal.completed',payload:{terminal:'completed',text:'MUSE_RESULT'}}));
}`;

it.layer(layer)("Subscription CLI adapters", (it) => {
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "Kimi resumes, relays approval decisions, and cancels a pending turn",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* executable(kimi);
        const instance = yield* KimiDriver.create({
          instanceId,
          displayName: undefined,
          enabled: true,
          environment: [],
          config: { ...KimiDriver.defaultConfig(), binaryPath },
        });
        const session = yield* instance.adapter.startSession({
          threadId,
          runtimeMode: "approval-required",
          resumeCursor: { sessionId: "native-session" },
        });
        expect(session.resumeCursor).toEqual({ sessionId: "native-session" });
        expect((yield* instance.snapshot.getSnapshot).models[0]?.aliases).toContain("kimi-default");
        const events = yield* instance.adapter.streamEvents.pipe(
          Stream.takeUntil((e) => e.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const approval = yield* instance.adapter.streamEvents.pipe(
          Stream.filter((e) => e.type === "request.opened"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* instance.adapter.sendTurn({ threadId, input: "Please edit the file" });
        yield* Fiber.join(approval);
        yield* instance.adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make("permission"),
          "decline",
        );
        const result = yield* Fiber.join(events);
        expect(result.some((e) => e.type === "content.delta" && e.payload.delta === "DENIED")).toBe(
          true,
        );
        expect(result.at(-1)).toMatchObject({
          type: "turn.completed",
          payload: { state: "completed" },
        });
        const cancelled = yield* instance.adapter.streamEvents.pipe(
          Stream.takeUntil((e) => e.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* instance.adapter.sendTurn({ threadId, input: "Wait" });
        yield* instance.adapter.interruptTurn(threadId);
        expect((yield* Fiber.join(cancelled)).at(-1)).toMatchObject({
          payload: { state: "interrupted" },
        });
        yield* instance.adapter.stopSession(threadId);
        expect(yield* instance.adapter.hasSession(threadId)).toBe(false);
      }).pipe(Effect.scoped),
  );
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "Muse rejects unrelayable approvals and removes private prompts after completion and interruption",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig;
        const binaryPath = yield* executable(muse);
        const instance = yield* MuseDriver.create({
          instanceId,
          displayName: undefined,
          enabled: true,
          environment: [],
          config: { ...MuseDriver.defaultConfig(), binaryPath },
        });
        yield* instance.adapter.startSession({ threadId, runtimeMode: "approval-required" });
        const denied = yield* instance.adapter
          .sendTurn({ threadId, input: "Edit" })
          .pipe(Effect.result);
        expect(denied._tag).toBe("Failure");
        yield* instance.adapter.stopSession(threadId);
        yield* instance.adapter.startSession({ threadId, runtimeMode: "full-access" });
        const duplicate = yield* instance.adapter
          .startSession({ threadId, runtimeMode: "full-access" })
          .pipe(Effect.result);
        expect(duplicate._tag).toBe("Failure");
        const events = yield* instance.adapter.streamEvents.pipe(
          Stream.takeUntil((e) => e.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* instance.adapter.sendTurn({ threadId, input: "Reply" });
        const output = yield* Fiber.join(events);
        expect(
          output.some((e) => e.type === "content.delta" && e.payload.delta === "MUSE_RESULT"),
        ).toBe(true);
        yield* instance.adapter.stopSession(threadId);
        expect(yield* fs.exists(`${stateDir}/provider-handoffs/${threadId}.md.tmp`)).toBe(false);
        yield* instance.adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* instance.adapter.sendTurn({ threadId, input: "WAIT_FOR_STOP" });
        yield* instance.adapter.stopSession(threadId);
        expect(yield* fs.exists(`${stateDir}/provider-handoffs/${threadId}.md.tmp`)).toBe(false);
        expect(yield* instance.adapter.hasSession(threadId)).toBe(false);
      }).pipe(Effect.scoped),
  );
});
