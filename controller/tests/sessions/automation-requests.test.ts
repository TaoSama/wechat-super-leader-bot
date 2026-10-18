import { EventEmitter } from "node:events";
import { describe,it,expect,vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import type { IStore } from "../../src/store/interface.js";
import { AutomationRequests } from "../../src/sessions/automation-requests.js";
import { AutomationInspectOptionsSchema } from "../../src/sessions/automation-contracts.js";
class Socket extends EventEmitter {readyState=WebSocket.OPEN; messages:any[]=[];send(text:string,callback?:(error?:Error)=>void){this.messages.push(JSON.parse(text));callback?.();}}
const fake=()=>new Socket() as unknown as WebSocket;
const options={automationId:"daily",expectedAt:1000,notAfter:2000};
const evidence={...options,status:"completed",sessionId:"thread",turnId:"turn",text:"result",sources:["rollout"],observedAt:3000};
describe("native automation readonly requests",()=>{
 it("reports an offline node as unknown rather than failed or completed",async()=>{
  const hub=new NodeHub({} as IStore,new Map());
  expect(await hub.inspectAutomation("offline",options)).toMatchObject({...options,status:"unknown",reason:"node_offline",sources:[]});
  await expect(hub.listAutomations("offline")).rejects.toMatchObject({code:"automation_offline"});
 });
 it("binds replies to the authenticated node and exact socket generation",async()=>{
  const req=new AutomationRequests(),ws=fake();const promise=req.inspect("node",ws,options);const id=(ws as any).messages[0].requestId;
  expect(req.receive("other",ws,{type:"automation_response",requestId:id,inspection:evidence})).toBe(false);
  expect(req.receive("node",fake(),{type:"automation_response",requestId:id,inspection:evidence})).toBe(false);
  expect(req.receive("node",ws,{type:"automation_response",requestId:id,inspection:evidence})).toBe(true);
  expect(await promise).toEqual(evidence);
 });
 it("rejects a result for a different business window",async()=>{
  const req=new AutomationRequests(),ws=fake();const promise=req.inspect("node",ws,options);
  req.receive("node",ws,{type:"automation_response",requestId:(ws as any).messages[0].requestId,inspection:{...evidence,expectedAt:1001}});
  await expect(promise).rejects.toMatchObject({code:"automation_invalid_response"});
 });
 it("cancels pending remote reads on timeout and does not accept late results",async()=>{
  vi.useFakeTimers();const req=new AutomationRequests(),ws=fake();const promise=req.inspect("node",ws,options);
  const rejected=expect(promise).rejects.toMatchObject({code:"automation_timeout"});await vi.advanceTimersByTimeAsync(15001);await rejected;
  expect((ws as any).messages.at(-1).type).toBe("cancel_automation");
  expect(req.receive("node",ws,{type:"automation_response",requestId:(ws as any).messages[0].requestId,inspection:evidence})).toBe(false);vi.useRealTimers();
 });
 it("rejects completed claims lacking exact turn evidence",async()=>{
  const req=new AutomationRequests(),ws=fake();const promise=req.inspect("node",ws,options);
  req.receive("node",ws,{type:"automation_response",requestId:(ws as any).messages[0].requestId,inspection:{...evidence,turnId:undefined}});
  await expect(promise).rejects.toMatchObject({code:"automation_invalid_response"});
 });
 it("aborts and disconnects independently of replacement sockets",async()=>{
  const req=new AutomationRequests(),ws=fake(),signal=new AbortController();const a=req.list("node",ws,signal.signal);signal.abort();await expect(a).rejects.toMatchObject({code:"automation_cancelled"});
  const replacement=fake(),b=req.list("node",replacement);req.disconnect(ws);req.receive("node",replacement,{type:"automation_response",requestId:(replacement as any).messages[0].requestId,automations:[]});expect(await b).toEqual([]);
 });
 it("validates bounded time ranges and excludes path identities",()=>{
  expect(AutomationInspectOptionsSchema.safeParse({...options,automationId:"../bad"}).success).toBe(false);
  expect(AutomationInspectOptionsSchema.safeParse({...options,notAfter:999}).success).toBe(false);
  expect(AutomationInspectOptionsSchema.safeParse({...options,notAfter:8*86400000}).success).toBe(false);
 });
});

describe("shared bounded automation read queue",()=>{
 const replies=(req:AutomationRequests,node:string,ws:WebSocket)=>{
  for (const message of (ws as unknown as Socket).messages.splice(0)) {
   if (message.type === "list_automations") req.receive(node,ws,{type:"automation_response",requestId:message.requestId,automations:[]});
  }
 };
 it("eventually reads all 50 sources in per-node FIFO order",async()=>{
  const req=new AutomationRequests(),ws=fake();let active=0,maxActive=0;
  const order:string[]=[];
  (ws as unknown as Socket).send=(text,callback)=>{
   const message=JSON.parse(text);active++;maxActive=Math.max(maxActive,active);order.push(message.automationId);
   queueMicrotask(()=>{active--;req.receive("node",ws,{type:"automation_response",requestId:message.requestId,inspection:{...evidence,automationId:message.automationId}});});
   callback?.();
  };
  const result=await Promise.all(Array.from({length:50},(_,i)=>req.inspect("node",ws,{...options,automationId:`source${i}`})));
  expect(result).toHaveLength(50);expect(maxActive).toBe(4);
  expect(order).toEqual(Array.from({length:50},(_,i)=>`source${i}`));
 });
 it("shares node capacity between list and inspect while allowing other nodes past a full node",async()=>{
  const req=new AutomationRequests(),a=fake(),b=fake();
  const first=Array.from({length:4},()=>req.list("a",a));
  const inspection=req.inspect("a",a,options),listing=req.list("a",a),other=req.list("b",b);
  expect((a as unknown as Socket).messages).toHaveLength(4);
  expect((b as unknown as Socket).messages).toHaveLength(1);
  const id=(a as unknown as Socket).messages.shift().requestId;
  req.receive("a",a,{type:"automation_response",requestId:id,automations:[]});await Promise.resolve();
  expect((a as unknown as Socket).messages.at(-1).type).toBe("inspect_automation");
  const next=(a as unknown as Socket).messages.pop();
  req.receive("a",a,{type:"automation_response",requestId:next.requestId,inspection:evidence});await Promise.resolve();
  expect((a as unknown as Socket).messages.at(-1).type).toBe("list_automations");
  replies(req,"a",a);replies(req,"b",b);
  await Promise.all([...first,inspection,listing,other]);
 });
 it("keeps the global active limit and releases capacity on close",async()=>{
  const req=new AutomationRequests(),sockets=Array.from({length:5},()=>fake());
  const requests=sockets.flatMap((ws,i)=>Array.from({length:5},()=>req.list(`node${i}`,ws)));
  const outcomes=Promise.allSettled(requests);
  expect(sockets.reduce((sum,ws)=>sum+(ws as unknown as Socket).messages.length,0)).toBe(16);
  req.closeAll();expect((await outcomes).every(r=>r.status==="rejected")).toBe(true);
  const next=req.list("fresh",sockets[4]);replies(req,"fresh",sockets[4]);expect(await next).toEqual([]);
 });
 it("aborts queued work without sending it or cancelling an unrelated read",async()=>{
  const req=new AutomationRequests(),ws=fake(),signal=new AbortController();
  const active=Array.from({length:4},()=>req.list("node",ws));
  const queued=req.list("node",ws,signal.signal),outcome=expect(queued).rejects.toMatchObject({code:"automation_cancelled"});
  signal.abort();await outcome;expect((ws as unknown as Socket).messages).toHaveLength(4);
  replies(req,"node",ws);await Promise.all(active);
 });
 it("discards old socket active and queued requests without dispatching them on a replacement",async()=>{
  const req=new AutomationRequests(),old=fake(),replacement=fake();
  const outdated=Array.from({length:8},()=>req.list("node",old));
  const outcomes=Promise.allSettled(outdated),fresh=req.list("node",replacement);
  req.disconnect(old);await Promise.resolve();
  expect((old as unknown as Socket).messages).toHaveLength(4);
  expect((replacement as unknown as Socket).messages).toHaveLength(1);
  replies(req,"node",replacement);expect(await fresh).toEqual([]);
  expect((await outcomes).every(r=>r.status==="rejected")).toBe(true);
 });
 it("bounds queued requests and times out waiting reads without a remote cancel",async()=>{
  vi.useFakeTimers();
  try {
   const req=new AutomationRequests(),ws=fake();
   const accepted=Array.from({length:132},()=>req.list("node",ws));
   const outcomes=Promise.allSettled(accepted);
   await expect(req.list("node",ws)).rejects.toMatchObject({code:"automation_busy"});
   await vi.advanceTimersByTimeAsync(240001);
   const result=await outcomes;
   expect(result.some(r=>r.status==="rejected"&&r.reason.code==="automation_queue_timeout")).toBe(true);
   const messages=(ws as unknown as Socket).messages;
   expect(messages.filter(m=>m.type==="list_automations")).toHaveLength(messages.filter(m=>m.type==="cancel_automation").length);
  } finally {vi.useRealTimers();}
 });
 it("frees a failed send slot so waiting requests can proceed",async()=>{
  const req=new AutomationRequests(),ws=fake();let sent=0;
  (ws as unknown as Socket).send=(text,callback)=>{
   const message=JSON.parse(text);sent++;
   if(sent===1)callback?.(new Error("closed"));
   else queueMicrotask(()=>req.receive("node",ws,{type:"automation_response",requestId:message.requestId,automations:[]}));
  };
  const results=await Promise.allSettled(Array.from({length:6},()=>req.list("node",ws)));
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(5);
  expect(results[0]).toMatchObject({status:"rejected",reason:{code:"automation_disconnected"}});
 });
});
