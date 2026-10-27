import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import { GatewaySettingsClient } from "../../src/settings/gateway-client.js";
import { validateGatewaySettingsUrl } from "../../src/runtime/config.js";
import { loadConfig } from "../../src/runtime/config.js";
import { wechatSessionId } from "../../src/sessions/wechat-history.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const upstream = express(); upstream.use(express.json());
  const requests: {path: string; authorization?: string; body: unknown}[] = [];
  upstream.use((req, _res, next) => { requests.push({path:req.originalUrl,authorization:req.headers.authorization,body:req.body}); next(); });
  upstream.get("/settings", (_req, res) => res.json({ scopes: [{id:"wechat",model:"test-wechat",revision:"rev-1"}],
    chats:[{chatId:"chat-1",label:"微信"},{chatId:"chat-other",label:"other"}], diagnostics:[] }));
  upstream.get("/settings/leader-history", (_req, res) => res.json({ threadId:"", items:[], nextCursor:null,
    fetchedAt:new Date().toISOString(), truncated:false }));
  upstream.get("/settings/resources", (req, res) => res.json({ resources: [
    {id:"gateway.system-prompt",kind:"prompt",title:"SP"}, ...(req.query.chatId ? [{id:"gateway.memory",kind:"memory"}] : [])] }));
  upstream.get("/settings/resources/gateway.system-prompt", (_req, res) => res.json({id:"gateway.system-prompt",content:"SP",revision:"a"}));
  upstream.post("/settings/resources/gateway.system-prompt", (_req, res) => res.status(409).json({error:"version changed",code:"revision_conflict"}));
  upstream.get("/settings/models", (_req, res) => res.json({scope:"wechat",models:[{id:"test-wechat",label:"Wechat",reasoningEfforts:["high"]}]}));
  upstream.post("/settings/models", (req, res) => res.json({...req.body,revision:"rev-2"}));
  const gatewayServer: Server = await new Promise(resolve => { const server = upstream.listen(0,"127.0.0.1",()=>resolve(server)); });
  const closeGateway = () => gatewayServer.listening ? new Promise<void>((resolve,reject)=>gatewayServer.close(error=>error?reject(error):resolve())) : Promise.resolve();
  cleanup.push(closeGateway);
  const root = await mkdtemp(path.join(tmpdir(),"settings-http-")); cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const controllerToken = "settings-controller-test-token";
  const server = new ControllerServer({port:0,host:"127.0.0.1",controllerToken,nodeTokens:{"test-node":"test-node-token"},tokenToNode:new Map([["test-node-token","test-node"]]),
    allowedChatIds:new Set(["chat-1"]),persistenceMode:"memory",commandTtlSeconds:60,
    consolePublicUrl:"http://localhost:8790",settingsRoot:root,
    gatewaySettingsUrl:`http://127.0.0.1:${(gatewayServer.address() as AddressInfo).port}`}, new MemoryStore());
  await server.start(); cleanup.push(()=>server.stop());
  const base = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
  const issued = await fetch(`${base}/v1/console-links`, {method:"POST",headers:{Authorization:`Bearer ${controllerToken}`,"Content-Type":"application/json"},
    body:JSON.stringify({requestId:"settings-login"})}).then(res=>res.json()) as {url:string};
  const exchange = await fetch(`${base}/auth/exchange`,{method:"POST",headers:{Origin:"http://localhost:8790","Content-Type":"application/json"},
    body:JSON.stringify({token:issued.url.split("#login=")[1]})});
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  const writeHeaders = {Cookie:cookie,Origin:"http://localhost:8790","Content-Type":"application/json","X-Super-Leader-Intent":"settings-update"};
  return {base,cookie,writeHeaders,requests,closeGateway};
}

describe("console settings", () => {
  it("authenticates browser reads, filters chats and keeps the upstream credential server-side", async () => {
    const f = await fixture();
    expect((await fetch(`${f.base}/v1/settings`)).status).toBe(401);
    const response = await fetch(`${f.base}/v1/settings`,{headers:{Cookie:f.cookie}});
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.chats).toEqual([{chatId:"chat-1",label:"微信"}]);
    expect(body.scopes.some((scope:any)=>scope.id==="wechat")).toBe(true);
    expect(body.diagnostics).toContainEqual(expect.objectContaining({id:"node-test-node",value:"离线",status:"warning"}));
    expect(f.requests[0]?.authorization).toBe("Bearer settings-controller-test-token");
    expect(JSON.stringify(body)).not.toContain("settings-controller-test-token");
  });

  it("requires same-origin settings intent for writes and preserves conflict status", async () => {
    const f = await fixture();
    const url = `${f.base}/v1/settings/resources/gateway.system-prompt`;
    const payload = JSON.stringify({content:"new prompt",expectedRevision:"a"});
    expect((await fetch(url,{method:"POST",headers:{Cookie:f.cookie,"Content-Type":"application/json"},body:payload})).status).toBe(403);
    expect((await fetch(url,{method:"POST",headers:{...f.writeHeaders,Origin:"https://elsewhere.test"},body:payload})).status).toBe(403);
    const saved = await fetch(url,{method:"POST",headers:f.writeHeaders,body:payload});
    expect(saved.status).toBe(409);
    expect(await saved.json()).toMatchObject({code:"revision_conflict"});
    expect(f.requests.filter(req=>req.path.includes("resources/gateway")).length).toBe(1);
  });

  it("validates chat authorization, named resources, model scopes and strict request bodies before proxying", async () => {
    const f = await fixture();
    expect((await fetch(`${f.base}/v1/settings/resources?chatId=chat-other`,{headers:{Cookie:f.cookie}})).status).toBe(403);
    expect((await fetch(`${f.base}/v1/settings/resources?chatId=chat-1&path=/etc/passwd`,{headers:{Cookie:f.cookie}})).status).toBe(400);
    expect((await fetch(`${f.base}/v1/settings/models?scope=desktop`,{headers:{Cookie:f.cookie}})).status).toBe(400);
    expect((await fetch(`${f.base}/v1/settings/resources/gateway.system-prompt`,{method:"POST",headers:f.writeHeaders,
      body:JSON.stringify({chatId:"chat-other",content:"changed",expectedRevision:"a"})})).status).toBe(403);
    const response = await fetch(`${f.base}/v1/settings/models`,{method:"POST",headers:f.writeHeaders,
      body:JSON.stringify({scope:"wechat",model:"test-wechat",reasoningEffort:"high",expectedRevision:"rev-1"})});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({scope:"wechat",revision:"rev-2"});
    expect(f.requests).toHaveLength(1);
  });

  it("retains local resources and explicit diagnostics when Gateway is offline", async () => {
    const f = await fixture();
    await f.closeGateway();
    const response = await fetch(`${f.base}/v1/settings`,{headers:{Cookie:f.cookie}});
    const snapshot = await response.json() as any;
    expect(response.status).toBe(200);
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({id:"gateway-settings",status:"error"}));
    const resources = await fetch(`${f.base}/v1/settings/resources`,{headers:{Cookie:f.cookie}}).then(res=>res.json()) as any;
    expect(resources.resources.some((resource:any)=>resource.id.startsWith("controller."))).toBe(true);
    expect((await fetch(`${f.base}/v1/settings/models?scope=wechat`,{headers:{Cookie:f.cookie}})).status).toBe(503);
  });

  it("exposes the authorized main WeChat task as a read-only synthetic session with empty history", async () => {
    const f = await fixture();
    const status = await fetch(`${f.base}/v1/status`, {headers:{Cookie:f.cookie}}).then(res => res.json()) as any;
    expect(status.nodes).toContainEqual(expect.objectContaining({nodeId:"wechat", connected:true, sessionCount:1}));
    expect(status.sessions).toContainEqual(expect.objectContaining({nodeId:"wechat", provider:"wechat-codex", historySource:"wechat-codex", capabilities:["read"]}));
    const sessionId = wechatSessionId("chat-1");
    const history = await fetch(`${f.base}/v1/sessions/wechat/${sessionId}/history`, {headers:{Cookie:f.cookie}});
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({source:"wechat-codex", session:{id:sessionId, provider:"wechat-codex"}, items:[]});
    const post = await fetch(`${f.base}/v1/sessions/wechat/${sessionId}/messages`, {method:"POST", headers:{Cookie:f.cookie,Origin:"http://localhost:8790","Content-Type":"application/json","X-Super-Leader-Intent":"session-message"}, body:JSON.stringify({prompt:"不要发送",requestId:"read-only"})});
    expect(post.status).toBe(403);
    const recovery = await fetch(`${f.base}/v1/sessions/wechat/${sessionId}/messages/request`, {headers:{Cookie:f.cookie}});
    expect(recovery.status).toBe(403);
    expect(f.requests.some(request => request.path.startsWith("/settings/leader-history"))).toBe(true);
  });
});

describe("Gateway settings transport", () => {
  it("aborts stalled dependencies at the caller's short snapshot deadline", async () => {
    let aborted = false;
    const client = new GatewaySettingsClient("http://gateway:8792", "test-token", async (_url, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal?.reason); }, {once:true});
      });
      return new Response("{}");
    });
    await expect(client.request("/settings", "GET", undefined, 10)).rejects.toMatchObject({statusCode:503});
    expect(aborted).toBe(true);
  });
  it("bounds a stalled body even when its cancellation never settles", async () => {
    let cancelled = false;
    const client = new GatewaySettingsClient("http://gateway:8792", "test-token", async () =>
      new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>{cancelled=true;return new Promise(()=>{});}})));
    await expect(client.request("/settings", "GET", undefined, 10)).rejects.toMatchObject({statusCode:503});
    expect(cancelled).toBe(true);
  });
  it("rejects redirected or invalid upstream replies without leaking credentials", async () => {
    const client = new GatewaySettingsClient("http://gateway:8792","sensitive-token",async (_url, init) => {
      expect(init?.redirect).toBe("error");
      return new Response("not-json");
    });
    await expect(client.request("/settings")).rejects.toMatchObject({statusCode:503,code:"GATEWAY_SETTINGS_UNAVAILABLE"});
  });
  it("validates fixed deployment origins without exposing rejected values", () => {
    expect(validateGatewaySettingsUrl("http://gateway:8792/")).toBe("http://gateway:8792");
    for (const value of ["http://user:secret@gateway", "https://gateway/settings", "file:///etc/passwd", "http://gateway#secret"]) {
      expect(()=>validateGatewaySettingsUrl(value)).toThrow("Invalid GATEWAY_SETTINGS_URL");
      expect(()=>validateGatewaySettingsUrl(value)).not.toThrow(/secret/);
    }
  });
  it("defaults to durable settings and validates configured settings roots", () => {
    const prior = process.env;
    try {
      process.env = {CONTROLLER_TOKEN:"test-token",PERSISTENCE_MODE:"memory",SUPER_LEADER_NO_DOTENV:"1"};
      expect(loadConfig().settingsRoot).toBe(path.resolve(".runtime/controller-runtime/settings"));
      process.env.CONTROLLER_DATA_ROOT = "/data/controller-runtime";
      expect(loadConfig().settingsRoot).toBe("/data/controller-runtime/settings");
      process.env.CONTROLLER_DATA_ROOT = "/";
      expect(() => loadConfig()).toThrow("CONTROLLER_DATA_ROOT must be a dedicated absolute directory");
      process.env.CONTROLLER_DATA_ROOT = "/data/controller-runtime";
      process.env.SETTINGS_ROOT = "relative/settings";
      expect(()=>loadConfig()).toThrow("SETTINGS_ROOT must be a dedicated absolute directory");
      process.env.SETTINGS_ROOT = "/";
      expect(()=>loadConfig()).toThrow("SETTINGS_ROOT must be a dedicated absolute directory");
      process.env.SETTINGS_ROOT = "/data/settings";
      expect(()=>loadConfig()).toThrow("SETTINGS_ROOT must be inside CONTROLLER_DATA_ROOT");
      process.env.SETTINGS_ROOT = "/data/controller-runtime/custom-settings";
      expect(loadConfig().settingsRoot).toBe("/data/controller-runtime/custom-settings");
      delete process.env.CONTROLLER_DATA_ROOT;
      process.env.SETTINGS_ROOT = "/data/settings";
      expect(loadConfig().settingsRoot).toBe("/data/settings");
    } finally { process.env = prior; }
  });
});
