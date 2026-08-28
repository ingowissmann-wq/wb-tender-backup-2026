import crypto from "node:crypto";
import {downloadPublicAIBietercockpitArchive} from "../platform/semantic-browser-auth.mjs";

const target=new URL(process.argv[2]||"https://www.deutsches-ausschreibungsblatt.de/VN/X-BBS-2026-0112");
if(target.protocol!=="https:"||target.hostname!=="www.deutsches-ausschreibungsblatt.de"||!/^\/VN\/[A-Za-z0-9._-]+$/.test(target.pathname))throw new Error("ai_bietercockpit_target_forbidden");
const fetched=await downloadPublicAIBietercockpitArchive(target.href,{maxBytes:500_000_000});
console.log(JSON.stringify({capturedAt:new Date().toISOString(),target:target.pathname,status:fetched.status,
  httpStatus:fetched.httpStatus,mime:fetched.mime,bytes:fetched.buffer.length,
  sha256:crypto.createHash("sha256").update(fetched.buffer).digest("hex"),externalWrite:false},null,2));
