import crypto from "node:crypto";

export const STRUCTURED_REGION_SCHEMA="WB_CORE_REGIONS_V1";
export const REGION_TYPES=Object.freeze(["PLACE_RADIUS","POSTAL_CODE","NUTS","STATE"]);
export const CANONICAL_SERVICES=Object.freeze(["security","cleaning","facility_management","sicherheitstechnik","emergency_services"]);

const SERVICE_ALIASES=Object.freeze({
  security:"security",cleaning:"cleaning",facility_management:"facility_management","facility-management":"facility_management",
  sicherheitstechnik:"sicherheitstechnik",emergency_services:"emergency_services","emergency-services":"emergency_services",
});
const STATE_BY_NAME=Object.freeze({
  "baden-württemberg":{nuts:"DE1",iso:"DE-BW",label:"Baden-Württemberg"},"baden-wuerttemberg":{nuts:"DE1",iso:"DE-BW",label:"Baden-Württemberg"},
  bayern:{nuts:"DE2",iso:"DE-BY",label:"Bayern"},berlin:{nuts:"DE3",iso:"DE-BE",label:"Berlin"},brandenburg:{nuts:"DE4",iso:"DE-BB",label:"Brandenburg"},
  bremen:{nuts:"DE5",iso:"DE-HB",label:"Bremen"},hamburg:{nuts:"DE6",iso:"DE-HH",label:"Hamburg"},hessen:{nuts:"DE7",iso:"DE-HE",label:"Hessen"},
  "mecklenburg-vorpommern":{nuts:"DE8",iso:"DE-MV",label:"Mecklenburg-Vorpommern"},niedersachsen:{nuts:"DE9",iso:"DE-NI",label:"Niedersachsen"},
  "nordrhein-westfalen":{nuts:"DEA",iso:"DE-NW",label:"Nordrhein-Westfalen"},"rheinland-pfalz":{nuts:"DEB",iso:"DE-RP",label:"Rheinland-Pfalz"},
  saarland:{nuts:"DEC",iso:"DE-SL",label:"Saarland"},sachsen:{nuts:"DED",iso:"DE-SN",label:"Sachsen"},"sachsen-anhalt":{nuts:"DEE",iso:"DE-ST",label:"Sachsen-Anhalt"},
  "schleswig-holstein":{nuts:"DEF",iso:"DE-SH",label:"Schleswig-Holstein"},thüringen:{nuts:"DEG",iso:"DE-TH",label:"Thüringen"},thueringen:{nuts:"DEG",iso:"DE-TH",label:"Thüringen"},
});
const STATE_BY_ISO=Object.freeze(Object.fromEntries(Object.values(STATE_BY_NAME).map(x=>[x.iso,x])));
const STATE_BY_NUTS=Object.freeze(Object.fromEntries(Object.values(STATE_BY_NAME).map(x=>[x.nuts,x])));
const localityKeys=["city","town","village","municipality","hamlet"];
let lastNominatimRequest=0,nominatimQueue=Promise.resolve();
let nutsLevel3Cache={loadedAt:0,promise:null};

export const normalizeText=value=>String(value??"").normalize("NFKC").trim().toLocaleLowerCase("de-DE").replace(/\s+/g," ");
export function canonicalService(value){return SERVICE_ALIASES[normalizeText(value).replaceAll(" ","_")]||null}
export function serviceLineForCanonical(value){const service=canonicalService(value);return service==="facility_management"?"facility-management":service==="emergency_services"?"emergency-services":service}
export function canonicalNuts(value){const result=String(value??"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"");return /^DE[1-9A-G][A-Z0-9]{0,2}$/.test(result)?result:null}
export function canonicalPostalCode(value){const result=String(value??"").trim();return /^\d{5}$/.test(result)?result:null}
export function canonicalState(value){const raw=normalizeText(value),byName=STATE_BY_NAME[raw],upper=String(value??"").trim().toUpperCase();return byName||STATE_BY_ISO[upper]||STATE_BY_NUTS[upper]||null}
const checksumValue=value=>{
  if(Array.isArray(value))return value.map(checksumValue);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>key!=="validatedAt").sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,checksumValue(item)]));
  return value;
};
export const regionChecksum=value=>crypto.createHash("sha256").update(JSON.stringify(checksumValue(value))).digest("hex");

export function isStructuredRegionConfiguration(value){return Boolean(value&&typeof value==="object"&&!Array.isArray(value)&&value.schema===STRUCTURED_REGION_SCHEMA&&Array.isArray(value.regions))}

function candidateFromNominatim(item){
  const address=item?.address||{},postalCode=canonicalPostalCode(address.postcode),state=canonicalState(address["ISO3166-2-lvl4"]||address.state),latitude=Number(item?.lat),longitude=Number(item?.lon);
  const localities=localityKeys.map(key=>address[key]).filter(Boolean).map(String);
  return {postalCode,state,latitude,longitude,localities,displayName:String(item?.display_name||""),reference:item?.osm_type&&item?.osm_id?`${String(item.osm_type).toUpperCase()[0]}${item.osm_id}`:String(item?.place_id||""),licence:String(item?.licence||"")};
}

export async function nominatimGeocode({place,postalCode,endpoint=process.env.REGION_GEOCODER_URL||"https://nominatim.openstreetmap.org/search",fetchImpl=fetch}){
  const prior=nominatimQueue;nominatimQueue=(async()=>{await prior.catch(()=>{});const wait=Math.max(0,1000-(Date.now()-lastNominatimRequest));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));lastNominatimRequest=Date.now()})();await nominatimQueue;
  // Resolve the postcode boundary first. Nominatim's structured city+postalcode
  // search returns the city boundary without a postcode for valid combinations.
  // The caller still requires the returned locality to match `place` exactly,
  // so omitting `city` here does not weaken the place/postcode uniqueness gate.
  const url=new URL(endpoint);url.searchParams.set("postalcode",postalCode);url.searchParams.set("countrycodes","de");url.searchParams.set("format","jsonv2");url.searchParams.set("addressdetails","1");url.searchParams.set("layer","address");url.searchParams.set("limit","10");
  const response=await fetchImpl(url,{headers:{accept:"application/json","user-agent":process.env.REGION_GEOCODER_USER_AGENT||"WB-Tender-Admin/1.0 (structured region validation)"},signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Object.assign(new Error("region_geocoder_unavailable"),{status:response.status});
  const body=await response.json();if(!Array.isArray(body))throw new Error("region_geocoder_invalid_response");return body.map(candidateFromNominatim);
}

export async function giscoNutsLookup(code,{fetchImpl=fetch,baseUrl=process.env.REGION_NUTS_REFERENCE_URL||"https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson"}={}){
  const level=code.length-2;if(level<1||level>3)return null;const response=await fetchImpl(`${baseUrl}/${encodeURIComponent(code)}-region-01m-4326-2024.geojson`,{headers:{accept:"application/geo+json,application/json","user-agent":process.env.REGION_GEOCODER_USER_AGENT||"WB-Tender-Admin/1.0 (NUTS validation)"},signal:AbortSignal.timeout(8000)});if(!response.ok)return null;const data=await response.json(),feature=data?.type==="Feature"?data:data?.features?.[0];return String(feature?.properties?.NUTS_ID||feature?.properties?.id||"").toUpperCase()===code?{code,name:feature.properties.NAME_LATN||feature.properties.NUTS_NAME||null,provider:"EUROSTAT_GISCO_NUTS_2024"}:null;
}

const onSegment=(point,a,b)=>{const cross=(point[1]-a[1])*(b[0]-a[0])-(point[0]-a[0])*(b[1]-a[1]);if(Math.abs(cross)>1e-10)return false;return point[0]>=Math.min(a[0],b[0])-1e-10&&point[0]<=Math.max(a[0],b[0])+1e-10&&point[1]>=Math.min(a[1],b[1])-1e-10&&point[1]<=Math.max(a[1],b[1])+1e-10};
const inRing=(point,ring)=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[j],b=ring[i];if(onSegment(point,a,b))return true;if((b[1]>point[1])!==(a[1]>point[1])&&point[0]<(a[0]-b[0])*(point[1]-b[1])/(a[1]-b[1])+b[0])inside=!inside}return inside};
const inPolygon=(point,polygon)=>Boolean(polygon?.[0]&&inRing(point,polygon[0])&&!polygon.slice(1).some(ring=>inRing(point,ring)));
const geometryContains=(point,geometry)=>geometry?.type==="Polygon"?inPolygon(point,geometry.coordinates):geometry?.type==="MultiPolygon"?geometry.coordinates.some(polygon=>inPolygon(point,polygon)):false;
const defaultNutsLevel3Url="https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_01M_2024_4326_LEVL_3.geojson";
async function loadNutsLevel3({fetchImpl,url}){
 const useCache=fetchImpl===fetch&&url===defaultNutsLevel3Url;
 if(useCache&&nutsLevel3Cache.promise&&Date.now()-nutsLevel3Cache.loadedAt<86_400_000)return nutsLevel3Cache.promise;
 const load=(async()=>{const response=await fetchImpl(url,{headers:{accept:"application/geo+json,application/json","user-agent":process.env.REGION_GEOCODER_USER_AGENT||"WB-Tender-Admin/1.0 (NUTS validation)"},signal:AbortSignal.timeout(20_000)});if(!response.ok)throw Object.assign(new Error("nuts_boundary_reference_unavailable"),{status:response.status});const length=Number(response.headers.get("content-length")||0);if(length>35_000_000)throw new Error("nuts_boundary_reference_too_large");const data=await response.json();if(data?.type!=="FeatureCollection"||!Array.isArray(data.features))throw new Error("nuts_boundary_reference_invalid");return data.features.filter(feature=>/^DE[1-9A-G][A-Z0-9]{2}$/.test(String(feature?.properties?.NUTS_ID||feature?.properties?.id||"")))})();
 if(useCache){const cached=load.catch(error=>{nutsLevel3Cache={loadedAt:0,promise:null};throw error});nutsLevel3Cache={loadedAt:Date.now(),promise:cached};return cached}
 return load;
}
export async function giscoNutsForPoint({latitude,longitude},{fetchImpl=fetch,url=process.env.REGION_NUTS_LEVEL3_URL||defaultNutsLevel3Url}={}){
 const lat=Number(latitude),lon=Number(longitude);if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<47||lat>56||lon<5||lon>16)return null;
 const features=await loadNutsLevel3({fetchImpl,url}),point=[lon,lat],matches=features.filter(feature=>geometryContains(point,feature.geometry));
 if(matches.length!==1)return null;
 const feature=matches[0],code=String(feature.properties.NUTS_ID||feature.properties.id||"").toUpperCase();
 return {code,name:feature.properties.NAME_LATN||feature.properties.NUTS_NAME||null,hierarchy:[code.slice(0,3),code.slice(0,4),code],provider:"EUROSTAT_GISCO_NUTS_2024",referenceUrl:url,referenceScale:"01M",referenceCrs:"EPSG:4326"};
}

const error=(code,message,row={})=>({...row,validationStatus:"INVALID",validationCode:code,validationMessage:message});
export async function validateStructuredRegionConfiguration(value,{geocode=nominatimGeocode,nutsLookup=giscoNutsLookup,nutsForPoint=giscoNutsForPoint,now=()=>new Date()}={}){
  if(!value||typeof value!=="object"||!Array.isArray(value.regions))return {valid:false,errors:["regions:structured_configuration_required"],configuration:null};
  if(!value.regions.length)return {valid:false,errors:["regions:at_least_one_region_required"],configuration:{schema:STRUCTURED_REGION_SCHEMA,regions:[]}};
  const rows=[];
  for(let index=0;index<value.regions.length;index++){
    const input=value.regions[index]||{},type=String(input.type||"").toUpperCase(),base={id:String(input.id||crypto.randomUUID()),type,place:String(input.place||"").trim()||null,postalCode:canonicalPostalCode(input.postalCode),state:canonicalState(input.state),radiusKm:input.radiusKm==null||input.radiusKm===""?null:Number(input.radiusKm),nutsCode:canonicalNuts(input.nutsCode)};
    if(!REGION_TYPES.includes(type)){rows.push(error("region_type_invalid","Bitte wählen Sie einen gültigen Regionstyp.",base));continue}
    if(type==="NUTS"){
      if(!base.nutsCode){rows.push(error("nuts_invalid","Der NUTS-Code ist nicht kanonisch oder unbekannt.",base));continue}
      let reference;try{reference=await nutsLookup(base.nutsCode)}catch{}if(!reference){rows.push(error("nuts_unresolved","Der NUTS-Code ist nicht in der amtlichen NUTS-2024-Referenz enthalten.",base));continue}
      rows.push({...base,state:canonicalState(base.nutsCode.slice(0,3))?.label||null,validationStatus:"VALID",validationCode:"NUTS_CANONICAL",validationMessage:"Kanonischer deutscher NUTS-Code amtlich geprüft.",evidence:{provider:reference.provider||"EUROSTAT_GISCO_NUTS_2024",referenceName:reference.name||null,validatedAt:now().toISOString()}});continue;
    }
    if(type==="STATE"){
      if(!base.state){rows.push(error("state_invalid","Das Bundesland konnte nicht kanonisch zugeordnet werden.",base));continue}
      rows.push({...base,nutsCode:base.state.nuts,state:base.state.label,validationStatus:"VALID",validationCode:"STATE_CANONICAL",validationMessage:"Bundesland und NUTS-1-Code eindeutig zugeordnet.",evidence:{provider:"ISO_3166_2_TO_NUTS1",isoCode:base.state.iso,validatedAt:now().toISOString()}});continue;
    }
    if(!base.postalCode){rows.push(error("postal_code_invalid","Eine fünfstellige deutsche Postleitzahl ist erforderlich.",base));continue}
    if(type==="PLACE_RADIUS"&&(!base.place||!Number.isFinite(base.radiusKm)||base.radiusKm<=0||base.radiusKm>500)){rows.push(error(!base.place?"place_required":"radius_invalid",!base.place?"Ort und eindeutige PLZ sind erforderlich.":"Der Radius muss größer als 0 und höchstens 500 km sein.",base));continue}
    let candidates;try{candidates=await geocode({place:base.place,postalCode:base.postalCode})}catch{rows.push(error("geocoder_unavailable","Die Ortsreferenz ist nicht erreichbar; die Region kann nicht aktiviert werden.",base));continue}
    const exact=(candidates||[]).filter(candidate=>candidate.postalCode===base.postalCode&&candidate.state&&Number.isFinite(candidate.latitude)&&Number.isFinite(candidate.longitude)&&(!base.place||candidate.localities.some(x=>normalizeText(x)===normalizeText(base.place))));
    const unique=new Map(exact.map(candidate=>[`${normalizeText(base.place||candidate.localities[0])}|${candidate.postalCode}|${candidate.state.iso}|${candidate.latitude.toFixed(5)}|${candidate.longitude.toFixed(5)}`,candidate]));
    if(unique.size!==1){rows.push(error(unique.size?"place_postal_ambiguous":"place_postal_unresolved",unique.size?"Ort und PLZ ergeben mehrere Treffer; die Region bleibt inaktiv.":"Ort und PLZ konnten nicht eindeutig aufgelöst werden.",base));continue}
    const match=[...unique.values()][0],normalizedPlace=base.place?match.localities.find(x=>normalizeText(x)===normalizeText(base.place)):match.localities[0]||match.displayName;
    let preciseNuts;try{preciseNuts=await nutsForPoint({latitude:match.latitude,longitude:match.longitude})}catch{}
    if(!preciseNuts||!/^DE[1-9A-G][A-Z0-9]{2}$/.test(preciseNuts.code)||!preciseNuts.code.startsWith(match.state.nuts)){rows.push(error("nuts_precision_unresolved","Für die eindeutigen Koordinaten konnte kein eindeutiger amtlicher NUTS-3-Code ermittelt werden. Die Region bleibt inaktiv.",{...base,place:normalizedPlace||base.place,state:match.state.label,nutsCode:null,latitude:match.latitude,longitude:match.longitude,evidence:{provider:"NOMINATIM_OSM",reference:match.reference,displayName:match.displayName,licence:match.licence,validatedAt:now().toISOString()}}));continue}
    rows.push({...base,place:normalizedPlace||base.place,state:match.state.label,nutsCode:preciseNuts.code,nutsHierarchy:preciseNuts.hierarchy,latitude:match.latitude,longitude:match.longitude,validationStatus:"VALID",validationCode:"PLACE_POSTAL_NUTS3_UNIQUE",validationMessage:"Ort, PLZ, Koordinaten und amtlicher NUTS-3-Code wurden eindeutig aufgelöst. Der Radius wird ausschließlich geographisch über Koordinaten ausgewertet.",evidence:{provider:"NOMINATIM_OSM",reference:match.reference,displayName:match.displayName,licence:match.licence,validatedAt:now().toISOString(),nutsProvider:preciseNuts.provider,nutsReferenceUrl:preciseNuts.referenceUrl,nutsReferenceScale:preciseNuts.referenceScale,nutsReferenceCrs:preciseNuts.referenceCrs,nutsReferenceName:preciseNuts.name,nutsHierarchy:preciseNuts.hierarchy}});
  }
  const errors=rows.flatMap((row,index)=>row.validationStatus==="VALID"?[]:[`regions.${index}:${row.validationCode}`]);
  const configuration={schema:STRUCTURED_REGION_SCHEMA,regions:rows};
  return {valid:errors.length===0,errors,configuration,checksum:regionChecksum(configuration)};
}

export function structuredRules(value){return isStructuredRegionConfiguration(value)?value.regions.filter(row=>row.validationStatus==="VALID"):[]}
export function haversineKm(a,b){const rad=x=>x*Math.PI/180,R=6371,dLat=rad(b.latitude-a.latitude),dLon=rad(b.longitude-a.longitude),x=Math.sin(dLat/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x))}

function sourceLocation(item){
  if(!item||typeof item!=="object")return null;const latitude=Number(item.latitude??item.lat),longitude=Number(item.longitude??item.lon),nutsCode=canonicalNuts(item.nuts??item.region),state=canonicalState(item.state??(nutsCode?.slice(0,3))),postalCode=canonicalPostalCode(item.postalCode??item.postal_code),place=String(item.locality??item.city??item.place??"").trim()||null;
  const result={latitude:Number.isFinite(latitude)?latitude:null,longitude:Number.isFinite(longitude)?longitude:null,nutsCode,state,postalCode,place};
  // Country-wide TED markers such as DEU/DE and non-geographic ANYW are
  // provenance, not additional performance locations. Keeping an all-null
  // location here turns one precise NUTS location into a false multi-region
  // result and turns a country-only notice into a false outside-region result.
  return result.nutsCode||result.state||result.postalCode||result.place||(result.latitude!==null&&result.longitude!==null)?result:null;
}
export function evaluateStructuredRegions(value,locations=[]){
  const rules=structuredRules(value),resolved=locations.map(sourceLocation).filter(Boolean),distinct=new Map(resolved.map(x=>[JSON.stringify(x),x]));
  if(!rules.length)return {classification:"REGION_UNRESOLVED",matchingStatus:"CONFIGURATION_REQUIRED",reason:"Keine gültige strukturierte Kernregion ist aktiv.",matches:[]};
  if(!distinct.size)return {classification:"REGION_UNRESOLVED",matchingStatus:"REGION_REVIEW_REQUIRED",reason:"Kein strukturierter Leistungsort vorhanden; der Auftraggeberstandort wird nicht ersatzweise verwendet.",matches:[]};
  if(distinct.size>1)return {classification:"MULTI_REGION_REVIEW",matchingStatus:"REGION_REVIEW_REQUIRED",reason:"Mehrere Leistungsorte müssen einzeln beziehungsweise losbezogen geprüft werden.",matches:[]};
  const location=[...distinct.values()][0],matches=[];let insufficient=false;
  for(const rule of rules){
    if(rule.type==="POSTAL_CODE"&&location.postalCode&&location.postalCode===rule.postalCode)matches.push({rule,distanceKm:null});
    else if(rule.type==="NUTS"&&location.nutsCode&&(location.nutsCode===rule.nutsCode||location.nutsCode.startsWith(rule.nutsCode)))matches.push({rule,distanceKm:null});
    else if(rule.type==="STATE"&&((location.state&&location.state.nuts===canonicalState(rule.state)?.nuts)||(location.nutsCode&&location.nutsCode.startsWith(rule.nutsCode))))matches.push({rule,distanceKm:null});
    else if(rule.type==="PLACE_RADIUS"){
      if(location.latitude===null||location.longitude===null){insufficient=true;continue}const distanceKm=haversineKm(rule,location);if(distanceKm<=rule.radiusKm)matches.push({rule,distanceKm});
    }
  }
  if(matches.length)return {classification:"CORE_REGION",matchingStatus:"REGION_GATE_PASSED",reason:"Der eindeutige Leistungsort entspricht der aktiven strukturierten Kernregionsversion.",matches};
  if(insufficient)return {classification:"REGION_UNRESOLVED",matchingStatus:"REGION_REVIEW_REQUIRED",reason:"Für die Radiusprüfung fehlen belegte Koordinaten des Leistungsorts.",matches:[]};
  return {classification:"OUTSIDE_CORE_REGION",matchingStatus:"OUTSIDE_CORE_REGION",reason:"Der eindeutige Leistungsort liegt außerhalb der aktiven strukturierten Kernregion.",matches:[]};
}
