import {inspectPortalLoginEntryWithBrowser} from "../platform/semantic-browser-auth.mjs";

const portals=[
  {canonical_domain:"vergabe.landbw.de",authentication_entry_url:"https://vergabe.landbw.de/NetServer/LoginControllerServlet?function=LoginForm&thContext=login"},
  {canonical_domain:"www.vergabe.stadt-frankfurt.de",authentication_entry_url:"https://www.vergabe.stadt-frankfurt.de/NetServer/LoginControllerServlet?function=LoginForm&thContext=login"},
  {canonical_domain:"www.ausschreibungen.ls.brandenburg.de",authentication_entry_url:"https://www.ausschreibungen.ls.brandenburg.de/NetServer/LoginControllerServlet?function=LoginForm&thContext=login"},
  {canonical_domain:"www.deutsches-ausschreibungsblatt.de",authentication_entry_url:"https://www.deutsches-ausschreibungsblatt.de/login"},
  {canonical_domain:"www.evergabe.nrw.de",authentication_domains:["id.vergabeplattform.nrw"],authentication_entry_url:"https://www.evergabe.nrw.de/VMPCenter/company/auth.do?method=show"},
  {canonical_domain:"www.vergabe.metropoleruhr.de",authentication_domains:["id.vergabeplattform.nrw"],authentication_entry_url:"https://www.vergabe.metropoleruhr.de/VMPSatellite/company/auth.do?method=show"},
  {canonical_domain:"plattform.aumass.de",authentication_entry_url:"https://plattform.aumass.de/"},
];

const results=[];
for(const portal of portals)results.push({portal:portal.canonical_domain,...await inspectPortalLoginEntryWithBrowser({portal})});
console.log(JSON.stringify({capturedAt:new Date().toISOString(),externalWrite:false,results},null,2));
if(results.some(result=>result.resultCode!=="LOGIN_ENTRY_DISCOVERED"))process.exitCode=1;
