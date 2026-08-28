import { XMLParser } from "fast-xml-parser";
const id=String(process.argv[2]||"");
if(!/^\d{6}-\d{4}$/.test(id))throw new Error("public TED notice id required");
const response=await fetch(`https://ted.europa.eu/en/notice/${id}/xml`,{headers:{accept:"application/xml,text/xml","user-agent":"WB-Tender-Lifecycle-ReadOnly-Evidence/1.0"}});
const xml=await response.text();
const document=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,trimValues:true}).parse(xml),paths=[];
function walk(node,path=[]){if(!node||typeof node!=="object")return;for(const[key,value]of Object.entries(node)){const next=[...path,key];if(/Deadline|ProcurementProjectLot|TenderingTerms|TenderingProcess|ID$/.test(key))paths.push(next.join("/"));for(const child of(Array.isArray(value)?value:[value]))walk(child,next)}}
walk(document);
console.log(JSON.stringify({status:response.status,contentType:response.headers.get("content-type"),bytes:Buffer.byteLength(xml),root:Object.keys(document),paths:[...new Set(paths)].slice(0,500)},null,2));
