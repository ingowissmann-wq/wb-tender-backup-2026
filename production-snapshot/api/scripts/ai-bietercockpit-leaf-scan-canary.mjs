import crypto from "node:crypto";
import {extractArchiveDocuments} from "../platform/binary-parsers.mjs";
import {scanBuffer,scannerVersion} from "../platform/malware-scanner.mjs";
import {downloadPublicAIBietercockpitArchive} from "../platform/semantic-browser-auth.mjs";

const fetched=await downloadPublicAIBietercockpitArchive("https://www.deutsches-ausschreibungsblatt.de/VN/X-BBS-2026-0112",{maxBytes:500_000_000});
const children=await extractArchiveDocuments(fetched.buffer),statuses={},types={},hashes=new Set();let totalBytes=0,largestBytes=0;
for(const child of children){
  const result=await scanBuffer(child.buffer),hash=crypto.createHash("sha256").update(child.buffer).digest("hex");
  statuses[result.status]=(statuses[result.status]||0)+1;types[child.mediaType]=(types[child.mediaType]||0)+1;
  hashes.add(hash);totalBytes+=child.buffer.length;largestBytes=Math.max(largestBytes,child.buffer.length);
}
console.log(JSON.stringify({capturedAt:new Date().toISOString(),archiveBytes:fetched.buffer.length,leafDocuments:children.length,uniqueLeafHashes:hashes.size,
  leafBytes:totalBytes,largestLeafBytes:largestBytes,types,statuses,scannerVersion:await scannerVersion(),externalWrite:false},null,2));
if(statuses.CLEAN!==children.length||hashes.size!==children.length)process.exitCode=1;
